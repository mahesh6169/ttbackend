// Paid ticket orders: the ONE place an order is made or released (feature 1015).
//
// Two paths reach it for the same Stripe PaymentIntent, whichever comes first:
//   - the buyer's browser: POST /events/:eventId/paid/confirm-payment
//   - Stripe's webhook:    payment_intent.amount_capturable_updated (hold) / payment_intent.succeeded
// The PendingOrder status moves atomically (pending -> issuing -> done | released) so only one
// path ever makes the tickets or releases the money; the other finds the result and reports it.
//
// Hold mode (capture_method manual): the card is only authorised at Pay. Tickets, invoice, seats
// and the discount count are written in one transaction, THEN the held money is taken. If the
// tickets cannot be made (sold out, seat taken, sales closed, ticket type stopped), the hold is
// cancelled - the buyer is never charged - and the seats are freed at once.
// Immediate mode (the checkout page from before feature 1015): money is already taken at Pay; a
// failure keeps the old behaviour (error to the browser, no tickets).
import mongoose from 'mongoose';
import stripe from '../../config/stripe.js';
import Event from '../../models/eventModel.js';
import EventInvoice from '../../models/eventInvoice.js';
import PaidTicket from '../../models/paidTicket.js';
import Reservation from '../../models/reservationModel.js';
import PendingOrder from '../../models/pendingOrder.js';
import {
  generateTicketNumber, validateTicketPurchase, calculateTicketPricing, createEventSnapshot,
  generateInvoiceNumber, normalizeDiscountCode, planPackIssuance,
} from './ticketHelpers.js';
import { stampAnswerIds } from './answerMatching.js';
import { getIO } from '../../socket/index.js';
import {
  sendTicketPurchaseConfirmationToBuyer, sendTicketSaleNotificationToOrganizer, sendPurchaseNotChargedToBuyer,
} from '../notifications/events/sendPaidTicketNotifications.js';

// An order is judged by when Pay was clicked, if it finishes within this window (same as the
// seat hold extension at create-payment-intent).
export const ORDER_WINDOW_MS = 15 * 60 * 1000;
// The moment an order's closing times are judged at: when Pay was clicked, if the order is being
// finished within the window; otherwise now.
export const orderJudgedAt = (startedAt, now = new Date()) =>
  (now.getTime() - new Date(startedAt).getTime() <= ORDER_WINDOW_MS ? new Date(startedAt) : now);

// A path that claimed an order but never finished (crash) loses its claim after this long.
const STALE_ISSUING_MS = 2 * 60 * 1000;
// Immediate mode: give the old checkout page this long to send the registration answers before
// the webhook makes the order without them (Stripe retries the webhook later).
const IMMEDIATE_WEBHOOK_GRACE_MS = 60 * 1000;

const PAID_STATES = ['succeeded', 'requires_capture'];

const NOT_CHARGED_TEXT = {
  SOLD_OUT: 'Sorry, the last tickets sold out while your payment was going through.',
  SEAT_TAKEN: 'Sorry, your seats were taken while your payment was going through.',
  SALES_CLOSED: 'Sorry, ticket sales for this event closed while your payment was going through.',
  UNAVAILABLE: 'Sorry, these tickets stopped being available while your payment was going through.',
  CAPTURE_FAILED: 'Sorry, we could not complete your payment.',
};
const PENDING_NOTE = 'Your card has not been charged. You may briefly see a pending amount, which your bank will remove.';

class OrderError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const totalOf = (tickets) => Object.values(tickets || {}).reduce((s, q) => s + Number(q || 0), 0);

const notChargedBody = (reason) => ({
  success: false,
  errorCode: 'NOT_CHARGED',
  reason,
  notCharged: true,
  message: `${NOT_CHARGED_TEXT[reason] || NOT_CHARGED_TEXT.UNAVAILABLE} ${PENDING_NOTE}`,
});

const doneBody = (invoice, tickets, idempotent) => ({
  success: true,
  message: idempotent ? 'Payment already confirmed; returning existing order' : 'Payment confirmed and tickets created successfully',
  ticketCount: tickets.length,
  seatedTickets: tickets.filter((t) => t.seats && t.seats.length > 0).length,
  invoiceNumber: invoice?.invoiceNumber,
  ticketIds: tickets.map((t) => t._id),
  ...(idempotent ? { idempotent: true } : {}),
});

// Old checkout wording for an immediate-mode (already charged) failure - unchanged behaviour.
const legacyFailure = (validation) => {
  if (validation.errorCode === 'SALES_CLOSED') {
    return { http: 400, body: { success: false, message: validation.error, errorCode: 'SALES_CLOSED' } };
  }
  let message = validation.error || 'Tickets are no longer available.';
  let http = 400;
  if (/sold out/.test(message)) {
    message = '🎫 Sorry! This event just sold out while you were completing your purchase. Please check back later for any cancellations.';
    http = 409;
  }
  return { http, body: { success: false, message, error: validation.error, requiresRefresh: true } };
};

const emitSeats = (eventId, seatIds, status, userId = null) => {
  try {
    const io = getIO();
    for (const seatId of seatIds) {
      io.to(`event_${eventId}`).emit('seat:status_changed', {
        seatId,
        status,
        userId: status === 'available' ? null : userId,
        reservedBy: status === 'available' ? null : userId,
        reservedUntil: null,
        timestamp: new Date(),
        operationType: status === 'available' ? 'release' : 'book',
      });
    }
  } catch (err) {
    console.log('Socket emit failed:', err.message);
  }
};

// Free this buyer's still-held seats (never a booked seat or someone else's hold).
const freeHeldSeats = async (eventId, userId, seatIds) => {
  if (!seatIds?.length) return;
  await Event.updateOne(
    { _id: eventId },
    {
      $set: {
        'seatingLayout.$[].seats.$[seat].status': 'available',
        'seatingLayout.$[].seats.$[seat].reservedBy': null,
        'seatingLayout.$[].seats.$[seat].reservedUntil': null,
        'seatingLayout.$[].seats.$[seat].sessionId': null,
      },
    },
    {
      arrayFilters: [{
        'seat.seatId': { $in: seatIds },
        'seat.status': { $in: ['selected', 'reserved'] },
        'seat.reservedBy': new mongoose.Types.ObjectId(String(userId)),
      }],
    }
  );
  emitSeats(String(eventId), seatIds, 'available');
};

// Book one seat for this buyer, atomically: only if it is still theirs (held) or still free.
// The match is decided by the query filter (matchedCount), not modifiedCount - the event schema's
// timestamps bump updatedAt on every update, so modifiedCount is 1 even when no seat matched.
const bookSeat = async (eventId, userId, seatId, session) => {
  const uid = new mongoose.Types.ObjectId(String(userId));
  const set = {
    $set: {
      'seatingLayout.$[].seats.$[seat].status': 'booked',
      'seatingLayout.$[].seats.$[seat].reservedBy': uid,
      'seatingLayout.$[].seats.$[seat].reservedUntil': null,
    },
  };
  const heldBy = { seatId, status: { $in: ['selected', 'reserved'] }, reservedBy: uid };
  const held = await Event.updateOne(
    { _id: eventId, 'seatingLayout.seats': { $elemMatch: heldBy } },
    set,
    { session, timestamps: false, arrayFilters: [{ 'seat.seatId': seatId, 'seat.status': { $in: ['selected', 'reserved'] }, 'seat.reservedBy': uid }] }
  );
  if (held.matchedCount === 1) return true;
  const free = await Event.updateOne(
    { _id: eventId, 'seatingLayout.seats': { $elemMatch: { seatId, status: 'available' } } },
    set,
    { session, timestamps: false, arrayFilters: [{ 'seat.seatId': seatId, 'seat.status': 'available' }] }
  );
  return free.matchedCount === 1;
};

const findSeat = (event, seatId) => {
  for (const row of event.seatingLayout || []) {
    const seat = (row.seats || []).find((s) => s.seatId === seatId);
    if (seat) return { row: row.rowLabel, seatNumber: seat.seatNumber };
  }
  return null;
};

// Send the buyer + organiser emails once per order (whoever flips the flag sends them).
const sendOrderEmailsOnce = async (invoiceId, organiserEmail) => {
  const claimed = await EventInvoice.findOneAndUpdate(
    { _id: invoiceId, notificationsPending: true },
    { $set: { notificationsPending: false, notificationsSentAt: new Date() } },
    { new: true }
  );
  if (!claimed) return;
  const tickets = await PaidTicket.find({ invoiceNumber: claimed.invoiceNumber }).sort({ createdAt: 1 });
  try {
    await sendTicketPurchaseConfirmationToBuyer({ invoice: claimed, tickets, event: claimed.eventSnapshot });
    if (organiserEmail) {
      await sendTicketSaleNotificationToOrganizer({
        invoice: claimed, tickets, event: claimed.eventSnapshot, organizerEmail: organiserEmail,
      });
    }
  } catch (err) {
    console.error('Error sending order emails:', err);
  }
};

// The order input, from the PendingOrder (normal) or, for a PaymentIntent created before
// feature 1015, from the browser body / the PaymentIntent metadata (as before).
const orderInput = (pending, paymentIntent, browser, event) => {
  const md = paymentIntent.metadata || {};
  if (pending) {
    return {
      tickets: pending.tickets,
      buyer: pending.buyer,
      formResponses: pending.formResponses || browser.formResponses || {},
      seatIds: pending.seatIds || [],
      plan: pending.issuancePlan,
      subtotalDollars: (pending.subtotalCents || 0) / 100,
      discountCode: pending.discountCode || '',
      discountDollars: (pending.discountCents || 0) / 100,
      startedAt: pending.createdAt,
    };
  }
  let tickets = browser.tickets;
  if (!tickets) {
    try { tickets = JSON.parse(md.ticketTypes || '{}'); } catch { tickets = {}; }
  }
  const [firstName, ...rest] = String(md.buyerName || '').split(' ');
  const buyer = browser.buyerInfo || { firstName, lastName: rest.join(' '), email: md.buyerEmail };
  let seatIds = [];
  try { seatIds = JSON.parse(md.seatIds || '[]'); } catch { seatIds = []; }
  const discountCode = md.discountCode || '';
  const discountDollars = parseFloat(md.discountAmount || '0') || 0;
  const dcDoc = discountCode
    ? (event.discountCodes || []).find((d) => normalizeDiscountCode(d.code) === normalizeDiscountCode(discountCode))
    : null;
  const coveredNames = dcDoc ? new Set(dcDoc.appliesToTicketTypes || []) : null;
  return {
    tickets,
    buyer,
    formResponses: browser.formResponses || {},
    seatIds,
    plan: planPackIssuance(event, tickets, discountCode && discountDollars > 0 ? Math.round(discountDollars * 100) : 0, coveredNames),
    subtotalDollars: calculateTicketPricing(event, tickets).total,
    discountCode,
    discountDollars,
    startedAt: new Date(paymentIntent.created * 1000),
  };
};

// Release an order that cannot be made: cancel the hold, free the seats, tell the buyer.
const releaseOrder = async ({ pending, paymentIntent, stripeAccountId, eventId, eventTitle, userId, input, reason }) => {
  if (pending) {
    const moved = await PendingOrder.findOneAndUpdate(
      { _id: pending._id, status: { $in: ['pending', 'issuing'] } },
      { $set: { status: 'released', releaseReason: reason, releasedAt: new Date() } },
      { new: true }
    );
    if (!moved) return notChargedBody(reason); // already released by the other path
  }
  try {
    await stripe.paymentIntents.cancel(paymentIntent.id, {}, { stripeAccount: stripeAccountId });
  } catch (err) {
    console.error(`Could not cancel payment hold ${paymentIntent.id}:`, err.message);
  }
  if (eventId) {
    await freeHeldSeats(eventId, userId, input?.seatIds);
    await Reservation.deleteMany({ eventId, userId, status: 'active' });
  }
  await sendPurchaseNotChargedToBuyer({
    buyer: input?.buyer,
    eventTitle,
    amountCents: paymentIntent.amount,
    reasonText: NOT_CHARGED_TEXT[reason] || NOT_CHARGED_TEXT.UNAVAILABLE,
  });
  console.log(`Order released (not charged): ${paymentIntent.id} reason ${reason}`);
  return notChargedBody(reason);
};

// Undo a committed order whose money could not be taken (very rare).
const undoOrder = async ({ invoice, eventId, userId, seatIds, discountCode }) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await PaidTicket.deleteMany({ invoiceNumber: invoice.invoiceNumber }, { session });
      await EventInvoice.deleteOne({ _id: invoice._id }, { session });
      if (seatIds?.length) {
        await Event.updateOne(
          { _id: eventId },
          {
            $set: {
              'seatingLayout.$[].seats.$[seat].status': 'available',
              'seatingLayout.$[].seats.$[seat].reservedBy': null,
              'seatingLayout.$[].seats.$[seat].reservedUntil': null,
            },
          },
          { session, arrayFilters: [{ 'seat.seatId': { $in: seatIds }, 'seat.status': 'booked', 'seat.reservedBy': new mongoose.Types.ObjectId(String(userId)) }] }
        );
      }
      if (discountCode) {
        await Event.updateOne(
          { _id: eventId },
          { $inc: { 'discountCodes.$[dc].usedCount': -1, 'discountCodes.$[dc].remainingUses': 1 } },
          { session, arrayFilters: [{ 'dc.code': discountCode, 'dc.remainingUses': { $ne: null } }] }
        );
        await Event.updateOne(
          { _id: eventId },
          { $inc: { 'discountCodes.$[dc].usedCount': -1 } },
          { session, arrayFilters: [{ 'dc.code': discountCode, 'dc.remainingUses': null }] }
        );
      }
    });
  } finally {
    await session.endSession();
  }
  if (seatIds?.length) emitSeats(String(eventId), seatIds, 'available');
};

// Make the order in one transaction. Throws OrderError(reason) when it cannot be made.
const createOrder = async ({ event, userId, paymentIntentId, stripeAccountId, input }) => {
  const eventId = event._id;
  const totalTickets = totalOf(input.tickets);
  const seated = Array.isArray(event.seatingLayout) && event.seatingLayout.length > 0;
  const seatIds = seated ? (input.seatIds || []).slice(0, totalTickets) : [];
  if (seated && seatIds.length !== totalTickets) throw new OrderError('SEAT_TAKEN');

  const eventSnapshot = createEventSnapshot(event);
  const invoiceNumber = await generateInvoiceNumber(event.eventCode);
  const discountedTotal = Number((input.subtotalDollars - input.discountDollars).toFixed(2));
  const stampedResponses = stampAnswerIds(
    Object.entries(input.formResponses || {}).map(([fieldName, response]) => ({ fieldName, response })),
    event.registrationFields || []
  );
  const buyer = input.buyer || {};

  let createdInvoice;
  let createdTickets = [];
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      createdTickets = [];
      const lineItems = [];

      // Lock: write the event doc first so two orders for this event serialise (the loser
      // retries after the winner commits and re-counts below).
      await Event.updateOne({ _id: eventId }, { $inc: { purchaseSeq: 1 } }, { session });

      if (event.capacity && event.capacity > 0) {
        const sold = await PaidTicket.countDocuments(
          { event: String(eventId), checkInStatus: { $in: ['confirmed', 'checked-in'] } },
          { session }
        );
        if (sold + totalTickets > event.capacity) throw new OrderError('SOLD_OUT');
      }

      const [invoiceDoc] = await EventInvoice.create([{
        invoiceNumber,
        event: eventId,
        user: userId,
        eventSnapshot,
        buyer: { firstName: buyer.firstName, lastName: buyer.lastName, email: buyer.email, phone: buyer.phone },
        gstIncluded: event.gstIncluded || false,
        refundPolicy: {
          processingFeePolicy: event.refundPolicy?.processingFeePolicy || '',
          policyText: event.refundPolicy?.policyText || '',
          termsAndConditions: event.refundPolicy?.termsAndConditions || '',
        },
        amounts: {
          total: discountedTotal,
          subtotal: input.subtotalDollars,
          ...(input.discountCode ? { discount: { code: input.discountCode, amount: input.discountDollars } } : {}),
          totalRefunded: 0,
          netAmount: discountedTotal,
        },
        payment: { paymentIntentId, stripeAccountId, paymentDate: new Date(), currency: 'AUD' },
        lineItems: [],
        refunds: [],
        status: 'paid',
        invoiceDate: new Date(),
        notificationsPending: true,
      }], { session });
      createdInvoice = invoiceDoc;

      for (const [i, entry] of input.plan.entries()) {
        let assignedSeats = [];
        if (seated) {
          const seatId = seatIds[i];
          const ok = await bookSeat(eventId, userId, seatId, session);
          if (!ok) throw new OrderError('SEAT_TAKEN');
          const where = findSeat(event, seatId) || {};
          assignedSeats = [{ seatId, row: where.row, seatNumber: where.seatNumber, ticketTypeId: entry.ticketTypeId }];
        }

        const ticketNumber = await generateTicketNumber(event.eventCode, session);
        const basePrice = Number((entry.basePriceCents / 100).toFixed(2));
        const totalPrice = Number((entry.netPriceCents / 100).toFixed(2));
        const pack = entry.packId ? { id: entry.packId, price: Number((entry.packPriceCents / 100).toFixed(2)) } : null;

        const [ticket] = await PaidTicket.create([{
          eventSnapshot,
          event: eventId,
          ticketNumber,
          invoiceNumber,
          user: userId,
          buyer: {
            firstName: buyer.firstName,
            lastName: buyer.lastName,
            email: buyer.email,
            phone: buyer.phone,
            agreedToTerms: buyer.agreeToTerms,
            termsAgreedAt: new Date(),
          },
          refundPolicyAcceptance: {
            policyType: event.refundPolicy?.processingFeePolicy || 'non-refundable',
            policyText: event.refundPolicy?.policyText || '',
            termsAndConditions: event.refundPolicy?.termsAndConditions || '',
            accepted: buyer.refundPolicyAccepted || false,
            acceptedAt: new Date(),
          },
          ticketType: { name: entry.name, price: basePrice, quantity: 1 },
          ...(pack ? { pack } : {}),
          priceDetails: { basePrice, totalPrice, ...(input.discountCode ? { discountCode: input.discountCode } : {}) },
          seats: assignedSeats,
          attendees: [{ name: `${buyer.firstName || ''} ${buyer.lastName || ''}`.trim(), checkedIn: false }],
          formResponses: stampedResponses,
          checkInStatus: 'confirmed',
          paymentIntentId,
          stripeAccountId,
          paymentDate: new Date(),
        }], { session });
        createdTickets.push(ticket);

        lineItems.push({
          ticketNumber: ticket.ticketNumber,
          ticketType: { name: entry.name, price: basePrice },
          ...(pack ? { pack } : {}),
          quantity: 1,
          discountAmount: Number(((entry.basePriceCents - entry.netPriceCents) / 100).toFixed(2)),
          seats: assignedSeats,
          attendeeName: `${buyer.firstName || ''} ${buyer.lastName || ''}`.trim(),
        });
      }

      createdInvoice.lineItems = lineItems;
      await createdInvoice.save({ session });

      // Discount use-count, once, in the same transaction (honour the price even past a cap).
      if (input.discountCode) {
        const dec = await Event.updateOne(
          { _id: eventId },
          { $inc: { 'discountCodes.$[dc].usedCount': 1, 'discountCodes.$[dc].remainingUses': -1 } },
          { session, arrayFilters: [{ 'dc.code': input.discountCode, 'dc.remainingUses': { $gt: 0 } }] }
        );
        if (dec.modifiedCount === 0) {
          await Event.updateOne(
            { _id: eventId },
            { $inc: { 'discountCodes.$[dc].usedCount': 1 } },
            { session, arrayFilters: [{ 'dc.code': input.discountCode }] }
          );
        }
      }

      // Edit-locking signals: first sale marks the event active and flags each type sold.
      const soldTypeNames = [...new Set(lineItems.map((li) => li?.ticketType?.name).filter(Boolean))];
      await Event.updateOne(
        { _id: eventId },
        { $set: { hasActivity: true, ...(soldTypeNames.length ? { 'ticketTypes.$[tt].hasSold': true } : {}) } },
        soldTypeNames.length ? { session, arrayFilters: [{ 'tt.name': { $in: soldTypeNames } }] } : { session }
      );
    });
  } finally {
    await session.endSession();
  }
  if (seatIds.length) emitSeats(String(eventId), seatIds, 'booked', userId);
  return { invoice: createdInvoice, tickets: createdTickets, seatIds };
};

const isDupOnPaymentIntent = (err) =>
  err && err.code === 11000 &&
  ((err.keyPattern && err.keyPattern['payment.paymentIntentId']) ||
   (typeof err.message === 'string' && err.message.includes('payment.paymentIntentId')));

/**
 * Finish a paid order. Returns { http, body } for the browser; the webhook only uses `retry`
 * (true = answer Stripe with an error so it tries again later).
 *
 * @param {object} p
 * @param {string} p.paymentIntentId
 * @param {string} [p.eventId]         from the URL (browser) or metadata (webhook)
 * @param {string} [p.stripeAccountId] connected account (webhook: event.account)
 * @param {string} [p.userId]          browser: the logged-in buyer (must match the payment)
 * @param {'browser'|'webhook'} p.source
 * @param {object} [p.browser]         confirm-payment body: { tickets, buyerInfo, formResponses }
 */
export const fulfilPaidOrder = async ({ paymentIntentId, eventId, stripeAccountId, userId, source, browser = {} }) => {
  let pending = await PendingOrder.findOne({ paymentIntentId });
  const evId = pending?.event || eventId;
  const event = evId ? await Event.findById(evId).populate('postedBy', 'stripeAccountId email name') : null;
  const account = pending?.stripeAccountId || stripeAccountId || event?.postedBy?.stripeAccountId;
  if (!account) return { http: 404, body: { success: false, message: 'Event not found' } };

  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {}, { stripeAccount: account });
  const md = paymentIntent.metadata || {};

  // Stripe's message only acts on orders this server knows. The same Stripe test account is used
  // by local UAT, GitHub CI and every developer PC, so a webhook can arrive here for a payment
  // made somewhere else - never touch (let alone release) one of those.
  if (source === 'webhook' && !pending && (md.captureMode === 'hold' || !event)) {
    return { http: 200, ignored: true, body: { success: false, message: 'Unknown order - ignored' } };
  }
  const buyerId = pending?.user ? String(pending.user) : md.userId;

  if (source === 'browser' && (String(userId) !== String(buyerId) || (md.eventId && md.eventId !== String(eventId)))) {
    return { http: 403, body: { success: false, message: 'Payment verification failed - mismatched user or event' } };
  }

  // Already made (by the other path, or a retry): finish any leftover steps and report it.
  const existing = await EventInvoice.findOne({ 'payment.paymentIntentId': paymentIntentId });
  if (existing) {
    if (paymentIntent.status === 'requires_capture') {
      try {
        await stripe.paymentIntents.capture(paymentIntentId, {}, { stripeAccount: account });
      } catch (err) {
        console.error(`Capture retry failed for ${paymentIntentId}:`, err.message);
      }
    }
    if (pending && pending.status !== 'done') {
      await PendingOrder.updateOne({ _id: pending._id }, { $set: { status: 'done', invoiceNumber: existing.invoiceNumber } });
    }
    await sendOrderEmailsOnce(existing._id, event?.postedBy?.email);
    const tickets = await PaidTicket.find({ paymentIntentId });
    return { http: 200, body: doneBody(existing, tickets, true) };
  }

  if (pending?.status === 'released') return { http: 409, body: notChargedBody(pending.releaseReason) };
  if (pending?.status === 'failed') {
    return { http: 409, body: { success: false, message: 'Tickets could not be issued for this payment. Please contact the organiser.', requiresRefresh: true } };
  }

  if (!PAID_STATES.includes(paymentIntent.status)) {
    return {
      http: 400,
      body: {
        success: false,
        message: `Payment has not been completed successfully. Payment status is ${paymentIntent.status}`,
        status: paymentIntent.status,
        paymentIntentId: paymentIntent.id,
      },
    };
  }

  const hold = paymentIntent.status === 'requires_capture';

  if (!event) {
    if (hold && pending) {
      return {
        http: 409,
        body: await releaseOrder({ pending, paymentIntent, stripeAccountId: account, userId: buyerId, input: pending ? { buyer: pending.buyer } : null, reason: 'UNAVAILABLE' }),
      };
    }
    return { http: 404, body: { success: false, message: 'Event not found' } };
  }

  // Immediate mode: let the old checkout page go first (it carries the registration answers).
  const startedMs = pending ? new Date(pending.createdAt).getTime() : paymentIntent.created * 1000;
  if (source === 'webhook' && !hold && (!pending || pending.status === 'pending') &&
      Date.now() - startedMs < IMMEDIATE_WEBHOOK_GRACE_MS) {
    return { http: 503, retry: true, body: { success: false, message: 'Waiting for the browser' } };
  }

  // Claim the order so only one path makes it.
  if (pending) {
    const claimed = await PendingOrder.findOneAndUpdate(
      {
        _id: pending._id,
        $or: [{ status: 'pending' }, { status: 'issuing', issuingAt: { $lt: new Date(Date.now() - STALE_ISSUING_MS) } }],
      },
      { $set: { status: 'issuing', issuingAt: new Date() } },
      { new: true }
    );
    if (!claimed) {
      // The other path is on it: wait briefly for its result.
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        const now = await PendingOrder.findById(pending._id);
        if (now.status === 'done' || now.status === 'released' || now.status === 'failed') {
          return fulfilPaidOrder({ paymentIntentId, eventId, stripeAccountId, userId, source, browser });
        }
      }
      return { http: 503, retry: true, body: { success: false, message: 'Your order is still being processed. Please check My Tickets in a minute.' } };
    }
    pending = claimed;
  }

  const input = orderInput(pending, paymentIntent, browser, event);
  const ctx = { pending, paymentIntent, stripeAccountId: account, eventId: event._id, eventTitle: event.title, userId: buyerId, input };

  // Closing times are judged at Pay, if the payment finished within the window.
  const judgeAt = orderJudgedAt(input.startedAt);
  const validation = await validateTicketPurchase(event, input.tickets, { at: judgeAt, skipCapacity: true });
  if (!validation.isValid) {
    const reason = validation.errorCode === 'SALES_CLOSED' ? 'SALES_CLOSED' : 'UNAVAILABLE';
    if (hold) return { http: 409, body: await releaseOrder({ ...ctx, reason }) };
    if (pending) await PendingOrder.updateOne({ _id: pending._id }, { $set: { status: 'failed', releaseReason: reason } });
    return legacyFailure(validation);
  }

  let made;
  try {
    made = await createOrder({ event, userId: buyerId, paymentIntentId, stripeAccountId: account, input });
  } catch (err) {
    if (isDupOnPaymentIntent(err)) {
      return fulfilPaidOrder({ paymentIntentId, eventId, stripeAccountId, userId, source, browser });
    }
    if (err instanceof OrderError) {
      if (hold) return { http: 409, body: await releaseOrder({ ...ctx, reason: err.reason }) };
      if (pending) await PendingOrder.updateOne({ _id: pending._id }, { $set: { status: 'failed', releaseReason: err.reason } });
      return err.reason === 'SOLD_OUT'
        ? legacyFailure({ error: 'Sorry, this event is now sold out!' })
        : { http: 500, body: { success: false, message: 'Failed to confirm payment and create tickets' } };
    }
    if (pending) await PendingOrder.updateOne({ _id: pending._id, status: 'issuing' }, { $set: { status: 'pending' } });
    throw err;
  }

  // Take the held money now that the tickets exist.
  if (hold) {
    try {
      const captured = await stripe.paymentIntents.capture(paymentIntentId, {}, { stripeAccount: account });
      if (captured.status !== 'succeeded') throw new Error(`capture status ${captured.status}`);
    } catch (err) {
      console.error(`Capture failed for ${paymentIntentId}, undoing the order:`, err.message);
      await undoOrder({ invoice: made.invoice, eventId: event._id, userId: buyerId, seatIds: made.seatIds, discountCode: input.discountCode });
      return { http: 409, body: await releaseOrder({ ...ctx, input: { ...input, seatIds: [] }, reason: 'CAPTURE_FAILED' }) };
    }
  }

  if (pending) {
    await PendingOrder.updateOne({ _id: pending._id }, { $set: { status: 'done', invoiceNumber: made.invoice.invoiceNumber } });
  }
  await Reservation.deleteMany({ eventId: event._id, userId: buyerId, status: 'active' });
  await sendOrderEmailsOnce(made.invoice._id, event.postedBy?.email);

  return { http: 200, body: doneBody(made.invoice, made.tickets, false) };
};
