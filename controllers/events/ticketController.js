// controllers/tickets/ticketController.js

import asyncHandler from 'express-async-handler';
import stripe from '../../config/stripe.js';
import mongoose from 'mongoose';
import Event from '../../models/eventModel.js';
import User from '../../models/userModel.js';
import EventInvoice from '../../models/eventInvoice.js';
import PaidTicket from '../../models/paidTicket.js';
import Reservation from '../../models/reservationModel.js';
import { generateTicketNumber, validateTicketPurchase, calculateTicketPricing, createEventSnapshot, generateInvoiceNumber, formatBuyerNameForStripe, validateDiscountCode, applyDiscount, splitDiscountAcrossTickets, normalizeDiscountCode, DISCOUNT_REASON_MESSAGES, planPackIssuance, isSalesOpen } from '../../utils/events/ticketHelpers.js';

import { assignSeatsToTicket } from '../../utils/events/seatHelpers.js';
import { cleanupExpiredReservations } from './reservationController.js';
import { sendTicketPurchaseConfirmationToBuyer, sendTicketSaleNotificationToOrganizer } from '../../utils/notifications/events/sendPaidTicketNotifications.js';
import { getEffectivePlatformFee, computeCommissionCents } from '../../utils/constants/platformPriceConfig.js';
import { stampAnswerIds } from '../../utils/events/answerMatching.js';


// @desc    Create Payment Intent for ticket purchase
// @route   POST /api/events/:eventId/paid/create-payment-intent
// @access  Private
export const createPaymentIntent = asyncHandler(async (req, res) => {
  
  try {
    const { tickets, buyerInfo, discountCode } = req.body;
    const eventId = req.params.eventId;
    const userId = req.user._id;

    // Validate required fields
    if (!eventId || !tickets || !buyerInfo) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: tickets or buyerInfo'
      });
    }

    // Clean up expired seat reservations before processing ticket purchase
    await cleanupExpiredReservations(eventId);
    
    // Fetch event with organizer details
    const event = await Event.findById(eventId).populate('postedBy', 'stripeAccountId email');
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Check if event is paid
    if (!event.isPaid) {
      return res.status(400).json({
        success: false,
        message: 'This is not a paid event'
      });
    }

    // REMOVED: Payment eligibility check - Stripe will handle this

    // Validate organizer has Stripe account
    if (!event.postedBy.stripeAccountId) {
      return res.status(400).json({
        success: false,
        message: 'Event organizer has not set up payment processing'
      });
    }

    // REMOVED: Account validation - Stripe will handle invalid accounts


    // Validate ticket purchase
    const validation = await validateTicketPurchase(event, tickets);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: validation.error,
        ...(validation.errorCode ? { errorCode: validation.errorCode } : {})
      });
    }

    // Seat reliability (Move 1+2 + pre-charge guard): for a seated event, the buyer must
    // still hold a live seat for EVERY ticket before we create the PaymentIntent. If the
    // hold lapsed (e.g. they lingered on checkout past the reservation window), reject here
    // — nothing is charged — instead of charging and then rolling back at confirm. When the
    // hold is good we extend it to survive card entry and record the seatIds so confirm
    // binds from an authoritative server-side list (not a fragile reservedBy re-scan).
    // The window is fixed (not env-based): card-entry time doesn't depend on environment.
    const PAYMENT_HOLD_MS = 15 * 60 * 1000; // 15 min — comfortably survives card entry
    const totalTickets = Object.values(tickets).reduce((sum, qty) => sum + qty, 0);
    let heldSeatIds = [];
    if (event.seatingLayout && event.seatingLayout.length > 0) {
      const reservation = await Reservation.findActiveReservation(eventId, userId);
      const now = new Date();

      // Seats genuinely held by THIS user right now (verified against the live layout).
      const heldByUser = [];
      if (reservation && reservation.seatIds && reservation.seatIds.length > 0) {
        for (const row of event.seatingLayout) {
          if (!row.seats || !Array.isArray(row.seats)) continue;
          for (const s of row.seats) {
            if (reservation.seatIds.includes(s.seatId) &&
                s.reservedBy && s.reservedBy.toString() === userId.toString() &&
                s.reservedUntil && s.reservedUntil > now &&
                (s.status === 'selected' || s.status === 'reserved')) {
              heldByUser.push(s.seatId);
            }
          }
        }
      }

      // PRE-CHARGE GUARD: no live hold for every ticket → refuse before any charge.
      if (heldByUser.length !== totalTickets) {
        return res.status(409).json({
          success: false,
          errorCode: 'SEAT_HOLD_EXPIRED',
          message: 'Your seat hold has expired. Please pick your seats again.',
          requiresSeatReselection: true
        });
      }

      // Hold is good — extend it to survive card entry (Move 1) and record the verified
      // seatIds for confirm to bind against (Move 2).
      const newExpiry = new Date(Date.now() + PAYMENT_HOLD_MS);
      reservation.expiresAt = newExpiry;
      await reservation.save();
      // Mirror addSeatsToReservation's array-filter update (reservationController.js:251).
      // Only touch this user's still-held seats — never a booked or someone else's seat.
      await Event.updateOne(
        { _id: eventId },
        { $set: { 'seatingLayout.$[].seats.$[seat].reservedUntil': newExpiry } },
        {
          arrayFilters: [{
            'seat.seatId': { $in: heldByUser },
            'seat.status': { $in: ['selected', 'reserved'] }
          }]
        }
      );
      heldSeatIds = heldByUser;
    }

    // Calculate pricing (pre-discount subtotal)
    const pricing = calculateTicketPricing(event, tickets);

    // Calculate platform fee using dynamic fee from event or default
    const totalTicketCount = Object.values(tickets).reduce((sum, qty) => sum + qty, 0);
    const effectiveFees = getEffectivePlatformFee(event);

    // ── Discount code (S4 step 3) ──────────────────────────────────────────────
    // Work in INTEGER CENTS (Fix #6 path). Start from the pre-discount subtotal.
    let subtotalCents = Math.round(pricing.total * 100);
    let totalAmountCents = subtotalCents;
    let discountCents = 0;
    let appliedDiscountCode = null;
    if (discountCode) {
      // Re-validate authoritatively. The buyer hasn't paid yet, so an invalid code is
      // rejected here (unlike confirm-payment, which honors the price post-charge).
      const dv = validateDiscountCode(event, discountCode, tickets);
      if (!dv.valid) {
        return res.status(400).json({
          success: false,
          errorCode: 'INVALID_DISCOUNT',
          message: DISCOUNT_REASON_MESSAGES[dv.reason] || 'This discount code cannot be applied.'
        });
      }
      const applied = applyDiscount(event, tickets, dv.code);   // covered-only, integer cents
      discountCents = applied.discountCents;
      totalAmountCents = applied.discountedTotalCents;
      appliedDiscountCode = dv.code.code;                        // normalized as stored

      // Silent $1 backstop (D10): after the discount, no single ticket - and no per-person share
      // in a covered pack - may fall below the flat $1 minimum. The wizard gate (S2) normally
      // prevents this; this catches drift after an edit or a crafted request. Checked on the
      // intended per-ticket split (before the order-level min-charge raise below), and rejects.
      const coveredNames = new Set(dv.code.appliesToTicketTypes || []);
      const floorPlan = planPackIssuance(event, tickets, discountCents, coveredNames);
      if (floorPlan.some(p => p.netPriceCents < 100)) {
        return res.status(400).json({
          success: false,
          errorCode: 'DISCOUNT_BELOW_MIN',
          message: 'This discount cannot be applied - it would make a ticket cost less than $1.'
        });
      }
    }

    // Fix #6: platform commission in INTEGER CENTS, computed on the DISCOUNTED total
    // (S4 step 4). computeCommissionCents is reused as-is — only the amount argument changed.
    let platformFeeCents = computeCommissionCents(totalAmountCents, totalTicketCount, effectiveFees);

    // S4 step 5 — minimum-charge guard: never charge below max($1, platform fee). If a
    // discount pushed the total under that floor, raise it back up (shrinking the effective
    // discount) and recompute the commission once. Wizard V6 makes this a rare backstop;
    // Stripe also rejects amount <= application_fee, so we never silently overcharge.
    const minChargeCents = Math.max(100, platformFeeCents);
    if (totalAmountCents < minChargeCents) {
      totalAmountCents = minChargeCents;
      discountCents = Math.max(0, subtotalCents - totalAmountCents);
      platformFeeCents = computeCommissionCents(totalAmountCents, totalTicketCount, effectiveFees);
    }

    // Display/metadata values (what the organizer sees), derived from the same integer path.
    const flatFeeCents = Math.round(totalTicketCount * effectiveFees.flatFee * 100);       // $0.80/ticket
    const percentageFeeCents = Math.round((totalAmountCents * effectiveFees.percentage) / 100);
    const totalFeesForOrganizerCents = flatFeeCents + percentageFeeCents;                  // 2% + $0.80, no absorption
    const organizerAmountCents = totalAmountCents - totalFeesForOrganizerCents;
    
    // Create Payment Intent - Stripe will handle account validation
    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount: totalAmountCents,
        currency: 'aud',
        payment_method_types: ['card'],
        
        // Direct charge configuration - charge in organizer's account
        application_fee_amount: platformFeeCents, // Platform fee (flat + percentage)
        
        // Metadata for tracking
        metadata: {
          eventId: eventId,
          userId: userId.toString(),
          ticketTypes: JSON.stringify(tickets),
          buyerEmail: buyerInfo.email,
          buyerName: `${buyerInfo.firstName} ${buyerInfo.lastName}`,
          eventTitle: event.title,
          organizerAccountId: event.postedBy.stripeAccountId,
          ticketCount: totalTicketCount.toString(),
          platformFeeFlat: effectiveFees.flatFee.toFixed(2),
          platformFeePercentage: effectiveFees.percentage.toFixed(2),
          totalPlatformFee: (platformFeeCents / 100).toFixed(2),
          organizerAmount: (organizerAmountCents / 100).toFixed(2),
          // Discount (S4 step 6) — confirm-payment reads these back to build the invoice +
          // per-ticket prices and to count the redemption. Empty/"0.00" when no code.
          discountCode: appliedDiscountCode || '',
          discountAmount: (discountCents / 100).toFixed(2),
          subtotal: (subtotalCents / 100).toFixed(2),
          // Authoritative held seats (Move 2). Empty "[]" for general-admission events.
          seatIds: JSON.stringify(heldSeatIds),
        },
        
        // Description
        description: `${event.eventCode} | ${formatBuyerNameForStripe(buyerInfo.firstName, buyerInfo.lastName)} | ${totalTicketCount} ${totalTicketCount === 1 ? 'ticket' : 'tickets'}`,
      }, {
        // Execute in organizer's Stripe account context
        stripeAccount: event.postedBy.stripeAccountId,
      });

    } catch (stripeError) {
      // SIMPLIFIED: Generic error handling instead of specialized account error handling
      console.error('❌ Stripe error creating payment intent:', stripeError);
      
      return res.status(400).json({
        success: false,
        message: `Payment processing error: ${stripeError.message}`,
        errorCode: 'STRIPE_ERROR',
        error: process.env.NODE_ENV === 'development' ? stripeError.message : undefined
      });
    }

    res.status(200).json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      stripeAccountId: event.postedBy.stripeAccountId,
      // Augment pricing with the discounted figures for the checkout Option-A summary.
      pricing: {
        ...pricing,
        subtotal: subtotalCents / 100,
        discountCode: appliedDiscountCode,
        discountAmount: discountCents / 100,
        total: totalAmountCents / 100
      }
    });

  } catch (error) {
    console.error('❌ Error creating payment intent:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create payment intent',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @desc    Confirm payment and create tickets
// @route   POST /api/events/:eventId/paid/confirm-payment
// @access  Private
export const confirmPayment = asyncHandler(async (req, res) => {
  
  try {
    const { paymentIntentId, tickets, buyerInfo, formResponses = {} } = req.body;
    const eventId = req.params.eventId;
    const userId = req.user._id;

    // Clean up expired seat reservations before confirming payment
    await cleanupExpiredReservations(eventId);

    // Retrieve payment intent from Stripe
    const event = await Event.findById(eventId).populate('postedBy', 'stripeAccountId email name');
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Early cutoff guard: reject before any Stripe call so no charge is attempted (D3).
    if (!isSalesOpen(event)) {
      return res.status(400).json({
        success: false,
        message: 'Ticket sales for this event have closed.',
        errorCode: 'SALES_CLOSED',
      });
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      stripeAccount: event.postedBy.stripeAccountId
    });

    // Validate card type if payment method is available
    if (paymentIntent.payment_method && paymentIntent.charges?.data?.[0]?.payment_method_details?.card) {
      const cardDetails = paymentIntent.charges.data[0].payment_method_details.card;
      const cardBrand = cardDetails.brand;
      const cardCountry = cardDetails.country;
      
      // Block non-Visa/Mastercard
      if (!['visa', 'mastercard'].includes(cardBrand)) {
        console.error('Blocked card brand:', cardBrand);
        return res.status(400).json({
          success: false,
          message: 'Sorry, we only accept Visa and Mastercard. Please use a different card.',
          errorCode: 'INVALID_CARD_BRAND'
        });
      }
      
      // Optionally block non-AU cards
      if (cardCountry !== 'AU') {
        console.error('Blocked international card:', cardCountry);
        return res.status(400).json({
          success: false,
          message: 'Sorry, we only accept Australian-issued cards. Please use a domestic card.',
          errorCode: 'INTERNATIONAL_CARD'
        });
      }
    }

    // Real payment verification only (no simulation)
    if (paymentIntent.status === 'succeeded') {
      // Proceed with ticket creation
    } else if (paymentIntent.status === 'requires_capture') {
      
       try {
        const capturedPayment = await stripe.paymentIntents.capture(paymentIntentId, {
          stripeAccount: event.postedBy.stripeAccountId,
        });
        
        if (capturedPayment.status !== 'succeeded') {
          return res.status(400).json({
            success: false,
            message: 'Payment capture failed',
            status: capturedPayment.status
          });
        }
      } catch (captureError) {
        console.error('Error capturing payment:', captureError);
        return res.status(400).json({
          success: false,
          message: 'Failed to capture payment',
          error: captureError.message
        });
      }
    } else {
      
      const statusMessages = {
        'requires_payment_method': 'Payment method is required',
        'requires_confirmation': 'Payment needs to be confirmed on the client side',
        'requires_action': 'Additional action required (e.g., 3D Secure authentication)',
        'processing': 'Payment is being processed, please wait',
        'requires_capture': 'Payment requires manual capture',
        'canceled': 'Payment was canceled',
        'failed': 'Payment failed'
      };

      const message = statusMessages[paymentIntent.status] || `Payment status is ${paymentIntent.status}`;
      
      return res.status(400).json({
        success: false,
        message: `Payment has not been completed successfully. ${message}`,
        status: paymentIntent.status,
        paymentIntentId: paymentIntent.id
      });
    }

    // Verify payment intent belongs to this user and event
    if (paymentIntent.metadata.userId !== userId.toString() ||
        paymentIntent.metadata.eventId !== eventId) {
      return res.status(403).json({
        success: false,
        message: 'Payment verification failed - mismatched user or event'
      });
    }

    // Fix #1 (idempotency — fast path): if this payment intent already produced an order,
    // return that order instead of creating tickets again (double-click / refresh / retry).
    // Must run BEFORE the availability re-check below, so a legitimate retry is never
    // rejected just because the event has since sold out.
    const existingInvoice = await EventInvoice.findOne({ 'payment.paymentIntentId': paymentIntentId });
    if (existingInvoice) {
      const existingTickets = await PaidTicket.find({ paymentIntentId });
      return res.status(200).json({
        success: true,
        message: 'Payment already confirmed; returning existing order',
        ticketCount: existingTickets.length,
        seatedTickets: existingTickets.filter(t => t.seats && t.seats.length > 0).length,
        invoiceNumber: existingInvoice.invoiceNumber,
        ticketIds: existingTickets.map(ticket => ticket._id),
        idempotent: true
      });
    }

    // Re-validate ticket availability (in case of race conditions)
    const validation = await validateTicketPurchase(event, tickets);
    if (!validation.isValid) {
      // Sales closed is its own deterministic branch (D3): return it immediately without
      // the capacity-race wording so the frontend can map errorCode deterministically.
      if (validation.errorCode === 'SALES_CLOSED') {
        return res.status(400).json({
          success: false,
          message: validation.error,
          errorCode: 'SALES_CLOSED',
        });
      }

      // User-friendly error messages based on the validation error
      let userMessage = validation.error;
      let statusCode = 400;

      // Customize messages for common scenarios
      if (validation.error.includes('sold out')) {
        userMessage = '🎫 Sorry! This event just sold out while you were completing your purchase. Please check back later for any cancellations.';
        statusCode = 409; // Conflict
      } else if (validation.error.includes('Only') && validation.error.includes('remaining')) {
        userMessage = `🎫 ${validation.error} Someone else just purchased tickets. Please refresh and try again with fewer tickets.`;
        statusCode = 409; // Conflict
      } else if (validation.error.includes('Unable to verify')) {
        userMessage = '⚠️ We\'re having trouble verifying ticket availability. Please refresh the page and try again.';
        statusCode = 503; // Service Unavailable
      }

      return res.status(statusCode).json({
        success: false,
        message: userMessage,
        error: validation.error, // Include original error for debugging
        requiresRefresh: true
      });
    }

    // Calculate pricing again
    const pricing = calculateTicketPricing(event, tickets);

    // ── Discount (S4-B: read from metadata, HONOR the price — never re-reject here) ──
    // The card was already charged the discounted amount in the browser. Pull the code +
    // amount the intent locked in (createPaymentIntent wrote these) and build the invoice +
    // per-ticket prices from them, even if the organizer changed the code since.
    const metaDiscountCode = paymentIntent.metadata?.discountCode || '';
    const discountDollars = parseFloat(paymentIntent.metadata?.discountAmount || '0') || 0;
    const subtotalDollars = pricing.total;                                       // pre-discount
    const discountedTotalDollars = Number((subtotalDollars - discountDollars).toFixed(2));

    // Plan issuance (events-bundle-pricing.md S4). A bundle line becomes N real tickets whose
    // stored prices split the pack price in exact cents and share one pack tag; a single line
    // becomes independent tickets. The order discount is spread across covered pack/single units
    // then across their tickets, so each ticket stores its own discounted price and a covered
    // pack's tickets sum to the discounted pack price. The plan is in the SAME order the creation
    // loop below iterates (its index == createdTickets.length at create time).
    const dcDoc = metaDiscountCode
      ? event.discountCodes.find(d => normalizeDiscountCode(d.code) === normalizeDiscountCode(metaDiscountCode))
      : null;
    // null coveredNames = code was deleted mid-checkout → spread across ALL tickets so the
    // per-ticket prices still sum to what was charged (honor-price).
    const coveredNames = dcDoc ? new Set(dcDoc.appliesToTicketTypes || []) : null;
    const issuancePlan = planPackIssuance(
      event,
      tickets,
      metaDiscountCode && discountDollars > 0 ? Math.round(discountDollars * 100) : 0,
      coveredNames
    );

    // Create event snapshot for ticket independence
    const eventSnapshot = createEventSnapshot(event);

    // Generate invoice number
    const invoiceNumber = await generateInvoiceNumber(event.eventCode);

    // Create EventInvoice first

    // Calculate total ticket count for invoice
    const totalTicketCount = Object.values(tickets).reduce((sum, qty) => sum + qty, 0);

    const eventInvoiceData = {
      invoiceNumber,
      event: eventId, 
      user: userId,
      eventSnapshot,
      buyer: {
        firstName: buyerInfo.firstName,
        lastName: buyerInfo.lastName,
        email: buyerInfo.email,
        phone: buyerInfo.phone
      },
      
      // Invoice-specific display flags from event
      gstIncluded: event.gstIncluded || false,
      refundPolicy: {
        processingFeePolicy: event.refundPolicy?.processingFeePolicy || '',
        policyText: event.refundPolicy?.policyText || '',
        termsAndConditions: event.refundPolicy?.termsAndConditions || '' // events-terms-conditions.md
      },
      
      // Financial summary (S4-C: pre-discount subtotal + discount line + discounted total)
      amounts: {
        total: discountedTotalDollars,
        subtotal: subtotalDollars,
        ...(metaDiscountCode ? { discount: { code: metaDiscountCode, amount: discountDollars } } : {}),
        totalRefunded: 0,
        netAmount: discountedTotalDollars
      },
      
      // Payment information
      payment: {
        paymentIntentId: paymentIntentId,
        stripeAccountId: event.postedBy.stripeAccountId,
        paymentDate: new Date(),
        currency: 'AUD'
      },
      
      // Line items (will be populated as we create tickets)
      lineItems: [],
      
      // Initial state
      refunds: [],
      status: 'paid',
      invoiceDate: new Date()
    };

    // Fix #2 (atomicity) + Fix #1 (idempotency backstop): create the invoice, every ticket,
    // and the seat-booking updates inside ONE transaction — all commit or all roll back, so a
    // mid-loop failure can never leave an invoice with partial tickets or oversell capacity.
    // The unique payment-intent index still guards duplicates: a near-simultaneous retry that
    // races past the fast-path check trips it inside the transaction, which aborts and returns
    // the winning order in the catch after the loop.
    // (Everything from here down to the seat-status save runs inside the transaction callback.)
    let createdInvoice;
    let createdTickets = [];

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // Reset accumulators — withTransaction may re-run this callback on a transient error.
        createdTickets = [];
        const invoiceLineItems = [];

        // Create the invoice first (gated by the unique payment-intent index).
        const [invoiceDoc] = await EventInvoice.create([eventInvoiceData], { session });
        createdInvoice = invoiceDoc;

    // Handle seating system structure — bind from the authoritative seatIds recorded on the
    // PaymentIntent at payment start (Move 2), NOT a fragile reservedBy re-scan. Each recorded
    // seat is re-verified against the live layout: still held by THIS user, not expired, not
    // taken by anyone else. This makes the seat→ticket binding deterministic.
    let userReservation = null;
    let userReservedSeats = [];
    const totalTickets = Object.values(tickets).reduce((sum, qty) => sum + qty, 0);

    if (event.seatingLayout && event.seatingLayout.length > 0) {
      const currentTime = new Date();

      // Verify a live seat is still held by THIS user (not expired, not taken by anyone else).
      const isHeldByUser = (seat) =>
        seat.reservedBy &&
        seat.reservedBy.toString() === userId.toString() &&
        seat.reservedUntil &&
        seat.reservedUntil > currentTime &&
        (seat.status === 'reserved' || seat.status === 'selected');

      const pushSeat = (row, seat) => userReservedSeats.push({
        seatId: seat.seatId,
        row: row.rowLabel,
        seatNumber: seat.seatNumber,
        reservedUntil: seat.reservedUntil,
        sessionId: seat.sessionId
      });

      if (typeof paymentIntent.metadata?.seatIds === 'string') {
        // Authoritative path (Move 2): bind from the seatIds recorded at payment start.
        let recordedSeatIds = [];
        try {
          recordedSeatIds = JSON.parse(paymentIntent.metadata.seatIds || '[]');
        } catch {
          recordedSeatIds = [];
        }
        for (const seatId of recordedSeatIds) {
          for (const row of event.seatingLayout) {
            if (!row.seats || !Array.isArray(row.seats)) continue;
            const seat = row.seats.find(s => s.seatId === seatId);
            if (!seat) continue;
            if (isHeldByUser(seat)) pushSeat(row, seat);
            break; // seatId is unique across the layout
          }
        }
      } else {
        // Legacy fallback: a PaymentIntent created before Move 2 has no recorded seatIds.
        // Fall back to the original reservedBy scan so in-flight purchases during deploy
        // still complete.
        event.seatingLayout.forEach(row => {
          if (row.seats && Array.isArray(row.seats)) {
            row.seats.forEach(seat => {
              if (isHeldByUser(seat)) pushSeat(row, seat);
            });
          }
        });
      }

      if (userReservedSeats.length > 0) {
        userReservation = {
          seatIds: userReservedSeats.map(seat => seat.seatId),
          reservedUntil: Math.max(...userReservedSeats.map(seat => seat.reservedUntil)),
          sessionId: userReservedSeats[0].sessionId,
          seats: userReservedSeats
        };
      }

      // Count guard: a seated event MUST bind a real seat to every ticket. If it can't
      // (hold lapsed before pay, seat lost, etc.), throw to abort the transaction — no
      // invoice, no tickets, seats untouched — rather than issue a seatless "confirmed"
      // ticket. With the extended hold (Move 1) this is a rare backstop; a retry of the
      // same PaymentIntent (idempotency fast-path) re-binds and completes.
      if (userReservedSeats.length !== totalTickets) {
        throw new Error(
          `SEAT_BINDING_INCOMPLETE: bound ${userReservedSeats.length} of ${totalTickets} seat(s) for a seated event`
        );
      }
    }

    // Stamp the question id onto each answer for storage (D2) - additive, matched by name at buy time.
    const stampedResponses = stampAnswerIds(
      Object.entries(formResponses).map(([fieldName, response]) => ({ fieldName, response })),
      event.registrationFields || []
    );

    // Create tickets and assign seats from the issuance plan (inside the transaction; accumulators
    // declared above). Each plan entry is one PaidTicket, in order — its index == createdTickets.length.
    for (const entry of issuancePlan) {
      const ticketNumber = await generateTicketNumber(event.eventCode, session);

      // This ticket's own base + paid price (a bundle ticket carries its exact-cent share of the pack).
      const basePrice = Number((entry.basePriceCents / 100).toFixed(2));
      const totalPrice = Number((entry.netPriceCents / 100).toFixed(2));
      const perTicketDiscount = Number(((entry.basePriceCents - entry.netPriceCents) / 100).toFixed(2));

      // Initialize seat tracking
      let assignedSeats = [];

      // Create ticket with cleaned pricing structure
      const [ticket] = await PaidTicket.create([{
        eventSnapshot,
        event: eventId,
        ticketNumber,
        invoiceNumber,
        user: userId,
        buyer: {
          firstName: buyerInfo.firstName,
          lastName: buyerInfo.lastName,
          email: buyerInfo.email,
          phone: buyerInfo.phone,
          agreedToTerms: buyerInfo.agreeToTerms,
          termsAgreedAt: new Date(),
        },
        // Refund Policy Acceptance
        refundPolicyAcceptance: {
          policyType: event.refundPolicy?.processingFeePolicy || 'non-refundable',
          policyText: event.refundPolicy?.policyText || '',
          termsAndConditions: event.refundPolicy?.termsAndConditions || '', // events-terms-conditions.md
          accepted: buyerInfo.refundPolicyAccepted || false,
          acceptedAt: new Date()
        },
        ticketType: {
          name: entry.name,
          price: basePrice,
          quantity: 1
        },
        // Pack tag: the N tickets of a bundle pack share this id + the pack price (D7). Absent for singles.
        ...(entry.packId ? { pack: { id: entry.packId, price: Number((entry.packPriceCents / 100).toFixed(2)) } } : {}),
        priceDetails: {
          basePrice,
          totalPrice, // discounted price actually paid for THIS ticket (S4-D)
          ...(metaDiscountCode ? { discountCode: metaDiscountCode } : {})
        },
        seats: [],
        attendees: [{
          name: `${buyerInfo.firstName} ${buyerInfo.lastName}`,
          checkedIn: false
        }],
        // Answers link to their question by qid (events-rsvp-question-editing.md D2), text kept.
        formResponses: stampedResponses,
        checkInStatus: 'confirmed',
        paymentIntentId: paymentIntentId,
        stripeAccountId: event.postedBy.stripeAccountId,
        paymentDate: new Date()
      }], { session });

      // Assign seats if reservation exists. No try/catch here (Move 5): any failure must
      // propagate so the whole order rolls back (all-or-nothing) — never a seatless ticket.
      // The count guard above guarantees a seat exists for every ticket on a seated event.
      if (userReservation && userReservation.seatIds.length > 0) {
        const globalTicketIndex = createdTickets.length;

        if (globalTicketIndex < userReservation.seatIds.length) {
          const reservedSeat = userReservation.seats[globalTicketIndex];

          if (reservedSeat) {
            // Create seat object for ticket
            const assignedSeat = {
              seatId: reservedSeat.seatId,
              row: reservedSeat.row,
              seatNumber: reservedSeat.seatNumber,
              ticketTypeId: entry.ticketTypeId
            };

            ticket.seats = [assignedSeat];
            assignedSeats = [assignedSeat];
            await ticket.save({ session });

            // Update seat status in event's seating layout to 'booked'
            let seatUpdated = false;
            for (let row of event.seatingLayout) {
              if (row.seats && Array.isArray(row.seats)) {
                for (let seat of row.seats) {
                  if (seat.seatId === reservedSeat.seatId) {
                    seat.status = 'booked';
                    seat.reservedBy = userId;
                    seat.reservedUntil = null;
                    seatUpdated = true;
                    break;
                  }
                }
              }
              if (seatUpdated) break;
            }
          }
        }
      }

      createdTickets.push(ticket);

      // Create invoice line item (one per ticket; the invoice API collapses a pack's rows into one
      // "admits N" line via the shared pack tag).
      invoiceLineItems.push({
        ticketNumber: ticket.ticketNumber,
        ticketType: {
          name: entry.name,
          price: basePrice
        },
        ...(entry.packId ? { pack: { id: entry.packId, price: Number((entry.packPriceCents / 100).toFixed(2)) } } : {}),
        quantity: 1,
        discountAmount: perTicketDiscount,
        seats: assignedSeats,
        attendeeName: `${buyerInfo.firstName} ${buyerInfo.lastName}`
      });
    }

        // Update EventInvoice with line items (same transaction).
        createdInvoice.lineItems = invoiceLineItems;
        await createdInvoice.save({ session });

        // Persist seat-status changes to 'booked' (same transaction). No longer swallowed:
        // a failure here must abort the whole order so it stays all-or-nothing (Fix #2).
        if (event.seatingLayout && event.seatingLayout.length > 0) {
          await event.save({ session });
        }

        // Discount use-count (S4-B) — count this redemption exactly once, atomically, in the
        // SAME order transaction. Runs AFTER the seat save on purpose: event.save() rewrites
        // discountCodes from the stale in-memory doc and would otherwise clobber this $inc.
        // Guarded decrement (remainingUses > 0) is race-safe; if the code is unlimited or just
        // hit its cap we still bump usedCount and HONOR the price — never fail the order.
        if (metaDiscountCode) {
          const dec = await Event.updateOne(
            { _id: eventId },
            { $inc: { 'discountCodes.$[dc].usedCount': 1, 'discountCodes.$[dc].remainingUses': -1 } },
            { session, arrayFilters: [{ 'dc.code': metaDiscountCode, 'dc.remainingUses': { $gt: 0 } }] }
          );
          if (dec.modifiedCount === 0) {
            // Unlimited (remainingUses null) OR already at the cap. Bump usedCount only —
            // never push remainingUses negative. Over-cap = honor-price overshoot (S4-B); log.
            await Event.updateOne(
              { _id: eventId },
              { $inc: { 'discountCodes.$[dc].usedCount': 1 } },
              { session, arrayFilters: [{ 'dc.code': metaDiscountCode }] }
            );
            if (dcDoc && dcDoc.remainingUses != null) {
              console.warn(`⚠️ Discount ${metaDiscountCode} redeemed past its limit (honored — S4-B) for event ${eventId}`);
            }
          }
        }

        // Edit-locking signals (events-edit-locking.md D4/D8): the first sale marks the event
        // active and flags each ticket type sold in THIS order. Atomic $set after event.save()
        // (which rewrites from the stale in-memory doc) so it is not clobbered — same reason the
        // discount counter above runs here.
        const soldTypeNames = [...new Set(invoiceLineItems.map((li) => li?.ticketType?.name).filter(Boolean))];
        await Event.updateOne(
          { _id: eventId },
          {
            $set: {
              hasActivity: true,
              ...(soldTypeNames.length ? { 'ticketTypes.$[tt].hasSold': true } : {}),
            },
          },
          soldTypeNames.length
            ? { session, arrayFilters: [{ 'tt.name': { $in: soldTypeNames } }] }
            : { session }
        );
      });
    } catch (txnErr) {
      await session.endSession();
      // Fix #1 backstop: a near-simultaneous double-submit tripped the unique payment-intent
      // index inside the transaction, so it rolled back and no duplicate order exists. Return
      // the winning order. Only a duplicate on the PAYMENT-INTENT index is idempotent; any
      // other duplicate-key (e.g. a ticket/invoice-number race) is a real error and bubbles up.
      const dupOnPaymentIntent =
        txnErr && txnErr.code === 11000 &&
        ((txnErr.keyPattern && txnErr.keyPattern['payment.paymentIntentId']) ||
         (typeof txnErr.message === 'string' && txnErr.message.includes('payment.paymentIntentId')));
      if (dupOnPaymentIntent) {
        const winnerInvoice = await EventInvoice.findOne({ 'payment.paymentIntentId': paymentIntentId });
        const winnerTickets = await PaidTicket.find({ paymentIntentId });
        return res.status(200).json({
          success: true,
          message: 'Payment already confirmed; returning existing order',
          ticketCount: winnerTickets.length,
          seatedTickets: winnerTickets.filter(t => t.seats && t.seats.length > 0).length,
          invoiceNumber: winnerInvoice ? winnerInvoice.invoiceNumber : undefined,
          ticketIds: winnerTickets.map(ticket => ticket._id),
          idempotent: true
        });
      }
      throw txnErr; // bubble to the outer catch → 500
    }
    await session.endSession();

    const seatedTickets = createdTickets.filter(t => t.seats && t.seats.length > 0);

    // Send email notifications
    try {
      // Send confirmation email to buyer
      await sendTicketPurchaseConfirmationToBuyer({
        invoice: createdInvoice,
        tickets: createdTickets,
        event: eventSnapshot
      });
      
      // Send notification email to organizer
      const organizerEmail = event.postedBy?.email;
      if (organizerEmail) {
        await sendTicketSaleNotificationToOrganizer({
          invoice: createdInvoice,
          tickets: createdTickets,
          event: eventSnapshot,
          organizerEmail: organizerEmail
        });
      }
      
      console.log('Email notifications sent successfully');
    } catch (emailError) {
      // Don't fail the entire transaction if email fails
      console.error('Error sending email notifications:', emailError);
    }

    res.status(200).json({
      success: true,
      message: 'Payment confirmed and tickets created successfully',
      ticketCount: createdTickets.length,
      seatedTickets: seatedTickets.length,
      invoiceNumber: createdInvoice.invoiceNumber,
      ticketIds: createdTickets.map(ticket => ticket._id)
    });

  } catch (error) {
    console.error('Error confirming payment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to confirm payment and create tickets',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @desc    Validate a discount code at checkout (the "Apply" button)
// @route   POST /api/events/:eventId/paid/validate-discount
// @access  Private
// Read-only: never mutates counters. create-payment-intent re-validates + applies
// authoritatively (S4); this just gives the checkout page its Option-A summary numbers.
export const validateDiscount = asyncHandler(async (req, res) => {
  try {
    const { code, tickets } = req.body;
    const eventId = req.params.eventId;

    if (!code || !tickets || Object.keys(tickets).length === 0) {
      return res.status(400).json({
        success: false,
        valid: false,
        message: 'Discount code and selected tickets are required'
      });
    }

    const event = await Event.findById(eventId).select('isPaid ticketTypes discountCodes');
    if (!event) {
      return res.status(404).json({ success: false, valid: false, message: 'Event not found' });
    }
    if (!event.isPaid) {
      return res.status(400).json({ success: false, valid: false, message: 'This is not a paid event' });
    }

    // S3 canonical rule set. An invalid code is an expected user case, not an HTTP
    // error — return 200 with valid:false + a message the checkout page shows inline.
    const result = validateDiscountCode(event, code, tickets);
    if (!result.valid) {
      return res.status(200).json({
        success: true,
        valid: false,
        reason: result.reason,
        message: DISCOUNT_REASON_MESSAGES[result.reason] || 'This discount code cannot be applied.'
      });
    }

    // Valid — compute the advisory summary numbers (dollars). create-payment-intent is
    // authoritative (incl. the minimum-charge guard); this total is for display (S3).
    const { subtotalCents, discountCents, discountedTotalCents } = applyDiscount(event, tickets, result.code);

    return res.status(200).json({
      success: true,
      valid: true,
      code: result.code.code,          // normalized as stored on the event
      kind: result.code.kind,
      value: result.code.value,
      appliesToTicketTypes: result.code.appliesToTicketTypes || [], // covered ticket-type NAMES (for the checkout "applies to" label)
      subtotal: subtotalCents / 100,
      discountAmount: discountCents / 100,
      total: discountedTotalCents / 100
    });

  } catch (error) {
    console.error('Error validating discount code:', error);
    res.status(500).json({ success: false, valid: false, message: 'Failed to validate discount code' });
  }
});

// @desc    Get user's tickets for a specific event
// @route   GET /api/events/:eventId/paid/my-tickets
// @access  Private
export const getMyTickets = asyncHandler(async (req, res) => {
  try {
    const eventId = req.params.eventId;
    const userId = req.user._id;

    const tickets = await PaidTicket.find({
      event: eventId,
      user: userId,
      checkInStatus: { $in: ['confirmed', 'checked-in'] }
    }).populate('event', 'title dateTime venue');

    res.status(200).json({
      success: true,
      tickets,
      count: tickets.length
    });

  } catch (error) {
    console.error('Error fetching user tickets:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tickets'
    });
  }
});

// @desc    Get user's tickets across all events
// @route   GET /api/events/paid/my-paid-tickets
// @access  Private
export const getMyAllPaidTickets = asyncHandler(async (req, res) => {
  try {
    const userId = req.user._id;

    // Fetch ALL tickets including cancelled/refunded ones
    // Frontend will handle displaying them with appropriate styling
    const tickets = await PaidTicket.find({
      user: userId
    })
    .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      tickets,
      count: tickets.length
    });

  } catch (error) {
    console.error('Error fetching user tickets:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tickets'
    });
  }
});

// @desc    Get ticket details by ticket number
// @route   GET /api/events/paid/ticket-details/:ticketNumber
// @access  Private
export const getTicketDetails = asyncHandler(async (req, res) => {
  try {
    const { ticketNumber } = req.params;
    
    const ticket = await PaidTicket.findOne({ ticketNumber })
      .populate('event', 'title dateTime venue address')
      .populate('user', 'name email');

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Ticket not found'
      });
    }

    // Only allow ticket owner or event organizer to view details
    const isOwner = ticket.user._id.toString() === req.user._id.toString();
    const isOrganizer = ticket.event.postedBy.toString() === req.user._id.toString();

    if (!isOwner && !isOrganizer) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this ticket'
      });
    }

    res.status(200).json({
      success: true,
      ticket
    });

  } catch (error) {
    console.error('Error fetching ticket details:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch ticket details'
    });
  }
});

// @desc    Get all tickets for an event (organizer only)
// @route   GET /api/events/:eventId/paid/all-tickets
// @access  Private (Organizer only)
export const getAllEventTickets = asyncHandler(async (req, res) => {
  
  try {
    const { eventId } = req.params;
    const organizerId = req.user._id;

    // Verify event ownership
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    if (event.postedBy.toString() !== organizerId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only event organizers can view all tickets'
      });
    }

    // Get all tickets for this event
    const tickets = await PaidTicket.find({
      event: eventId,
      checkInStatus: { $in: ['confirmed', 'checked-in'] }
    })
    .populate('user', 'name email')
    .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      tickets,
      count: tickets.length
    });

  } catch (error) {
    console.error('Error fetching event tickets:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch event tickets'
    });
  }
});

