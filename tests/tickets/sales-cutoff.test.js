// Ticket sales close at 11:59pm on the event day, in the event's own timezone - see
// featureplans/fix-events-sales-cutoff.md. Every buy path (reservation, payment intent, payment
// confirmation, waitlist) refuses with SALES_CLOSED after the cutoff, independent of the 5-day
// past-grace (expiryDate). Free RSVP reuses the same cutoff (tests/rsvp/register.test.js).
import { createOrganiser, createUser, createPaidEvent } from '../helpers/factories.js';
import { api, reserve, createPaymentIntent, BUYER, createHoldPaymentIntent, authoriseWithTestCard, confirmPurchase, stripePayment } from '../helpers/eventRequests.js';
import Event from '../../models/eventModel.js';
import PendingOrder from '../../models/pendingOrder.js';
import { daysAgo, daysFromNow } from '../helpers/dates.js';
import { isSalesOpen, validateTicketPurchase } from '../../utils/events/ticketHelpers.js';
import { orderJudgedAt } from '../../utils/events/paidOrderFulfilment.js';

// A paid event whose day ended two days ago (UTC) but is still inside the 5-day past-grace.
const closedEvent = (organiser, overrides = {}) =>
  createPaidEvent(organiser, { dateTime: daysAgo(2), timeZone: 'UTC', expiryDate: daysFromNow(5), ...overrides });

// A paid event that started a moment ago; in UTC its 11:59pm cutoff is reliably still ahead.
const startedEvent = (organiser) =>
  createPaidEvent(organiser, { dateTime: new Date(Date.now() - 1000), timeZone: 'UTC', capacity: 100 });

const typeIdOf = (event) => event.ticketTypes[0]._id.toString();

test('on the event day itself, before the cutoff, tickets can still be reserved and priced', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const event = await startedEvent(organiser);
  const ticketTypeId = typeIdOf(event);

  const res = await reserve(buyer, event._id, [{ ticketTypeId, quantity: 1 }]);
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);

  // Payment intent may fail for other reasons (no live Stripe account), but never the cutoff.
  const pay = await createPaymentIntent(buyer, event._id, { [ticketTypeId]: 1 });
  expect(pay.body.errorCode).not.toBe('SALES_CLOSED');
  if (pay.status === 400) {
    expect(pay.body.message).not.toMatch(/sales.*closed/i);
  }
});

test('reserving tickets after the cutoff is refused with sales closed', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const event = await closedEvent(organiser);

  const res = await reserve(buyer, event._id, [{ ticketTypeId: typeIdOf(event), quantity: 1 }]);
  expect(res.status).toBe(400);
  expect(res.body.errorCode).toBe('SALES_CLOSED');
});

test('pricing a payment after the cutoff is refused with sales closed', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const event = await closedEvent(organiser);

  const res = await createPaymentIntent(buyer, event._id, { [typeIdOf(event)]: 1 });
  expect(res.status).toBe(400);
  expect(res.body.errorCode).toBe('SALES_CLOSED');
  expect(res.body.message).toMatch(/Ticket sales for this event have closed/i);
});

test('confirming a payment after the cutoff is refused with sales closed', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const event = await closedEvent(organiser);

  // The cutoff guard in confirmPayment runs before the Stripe lookup, so any paymentIntentId
  // string reaches it without a Stripe call.
  const res = await api('post', `/api/events/${event._id}/paid/confirm-payment`, buyer).send({
    paymentIntentId: 'pi_test_stale',
    tickets: { [typeIdOf(event)]: 1 },
    buyerInfo: BUYER,
  });
  expect(res.status).toBe(400);
  expect(res.body.errorCode).toBe('SALES_CLOSED');
});

test('joining the waitlist of a full event after the cutoff is refused with sales closed', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  // The waitlist controller short-circuits with SALES_CLOSED for paid events before its full check.
  const event = await closedEvent(organiser, { capacity: 1, waitlistEnabled: true });

  const res = await api('post', `/api/events/${event._id}/waitlist/join`, buyer).send({});
  expect(res.status).toBe(400);
  expect(res.body.errorCode).toBe('SALES_CLOSED');
});

test('the cutoff is 11:59pm in the event\'s own timezone, not the server\'s day, and ignores the past-grace', () => {
  // Event dateTime = yesterday 20:00 UTC = today 04:00 in Australia/Perth (UTC+8), so its cutoff is
  // today 23:59 Perth = today 15:59 UTC. A UTC-only check would call it closed already.
  const today = new Date();
  const utc = (dayOffset, h, m) => new Date(Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + dayOffset, h, m, 0
  ));
  const perthEvent = { dateTime: utc(-1, 20, 0), timeZone: 'Australia/Perth' };

  // 14:00 UTC today = 22:00 Perth today: before the cutoff -> OPEN.
  expect(isSalesOpen(perthEvent, utc(0, 14, 0))).toBe(true);
  // 16:30 UTC today = 00:30 tomorrow Perth: after the cutoff -> CLOSED.
  expect(isSalesOpen(perthEvent, utc(0, 16, 30))).toBe(false);

  // An event whose day has passed reads closed even while its expiryDate grace is still running.
  expect(isSalesOpen({ dateTime: daysAgo(2), timeZone: 'UTC', expiryDate: daysFromNow(5) })).toBe(false);
});

// Feature 1015: an order is judged by when Pay was clicked. A buyer who clicks Pay before the
// cutoff and finishes a moment after it still gets their tickets - never "charged, sales closed".
test('sales closing while the buyer is paying: an order started before the cutoff is judged at Pay and honoured', async () => {
  // Midnight can't be staged end to end, so check the rule itself: an event whose cutoff fell 5
  // minutes ago, an order whose Pay was clicked 10 minutes ago (inside the 15-minute window).
  const now = new Date();
  const cutoffPassed = { isPaid: true, dateTime: daysAgo(1), timeZone: 'UTC', ticketTypes: [{ _id: 't1', name: 'Std', price: 10 }] };
  const tickets = { t1: 1 };
  const payClicked = new Date(now.getTime() - 10 * 60_000);
  // Sales are closed now...
  expect((await validateTicketPurchase(cutoffPassed, tickets, { skipCapacity: true })).errorCode).toBe('SALES_CLOSED');
  // ...but an order is judged when Pay was clicked, while they were still open.
  const at = orderJudgedAt(payClicked, now);
  expect(at.getTime()).toBe(payClicked.getTime());
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 23, 59, 59));
  expect(isSalesOpen(cutoffPassed, new Date(cutoff.getTime() - 60_000))).toBe(true);
  // A Pay click 20 minutes ago is outside the window: judged now (closed).
  expect(orderJudgedAt(new Date(now.getTime() - 20 * 60_000), now).getTime()).toBe(now.getTime());
});

test('...but a payment finished more than 15 minutes after the cutoff is released, not charged', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const event = await startedEvent(organiser);
  const pay = await createHoldPaymentIntent(buyer, event._id, { [typeIdOf(event)]: 1 });
  await authoriseWithTestCard(pay.body.paymentIntentId);
  await Event.updateOne({ _id: event._id }, { $set: { dateTime: daysAgo(2) } });
  await PendingOrder.collection.updateOne(
    { paymentIntentId: pay.body.paymentIntentId },
    { $set: { createdAt: new Date(Date.now() - 20 * 60_000) } }
  );

  const res = await confirmPurchase(buyer, event._id, pay.body.paymentIntentId);
  expect(res.status).toBe(409);
  expect(res.body.errorCode).toBe('NOT_CHARGED');
  expect(res.body.reason).toBe('SALES_CLOSED');
  expect((await stripePayment(pay.body.paymentIntentId)).status).toBe('canceled');
}, 60000);
