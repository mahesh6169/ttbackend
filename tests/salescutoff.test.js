// featureplans/fix-events-sales-cutoff.md
import request from 'supertest';
import app from '../app.js';
import {
  createOrganiser,
  createUser,
  createPaidEvent,
  cookieFor,
  API_KEY,
} from './helpers/factories.js';
import { isSalesOpen } from '../utils/events/ticketHelpers.js';

// Shared buyer info for create-payment-intent calls.
const BUYER = {
  firstName: 'Test',
  lastName: 'Buyer',
  email: 'buyer@test.dev',
  phone: '0412000001',
  agreeToTerms: true,
};

// Minimal tickets object (ticketTypeId inserted per-test after event creation).
const ticketsFor = (ticketTypeId) => ({ [ticketTypeId]: 1 });

// ---------------------------------------------------------------------------
// AC1: event started earlier today but sales window still open -> not SALES_CLOSED
// ---------------------------------------------------------------------------
test('AC1 - create-payment-intent is not refused with SALES_CLOSED when event started today but cutoff has not passed', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  // Event started 1 second ago - sales window is still open (cutoff = tonight 11:59pm).
  const now = new Date();
  const startedAMomentAgo = new Date(now.getTime() - 1000);
  const event = await createPaidEvent(organiser, {
    dateTime: startedAMomentAgo,
    timeZone: 'UTC', // UTC tz: 11:59pm UTC is reliably in the future during normal test runs.
  });
  const ticketTypeId = event.ticketTypes[0]._id.toString();

  const res = await request(app)
    .post(`/api/events/${event._id}/paid/create-payment-intent`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(buyer))
    .send({ tickets: ticketsFor(ticketTypeId), buyerInfo: BUYER });

  // Must not be refused with SALES_CLOSED. May fail for other reasons (no Stripe account, etc.)
  // but the time cutoff must not be the reason.
  expect(res.body.errorCode).not.toBe('SALES_CLOSED');
  if (res.status === 400) {
    expect(res.body.message).not.toMatch(/sales.*closed/i);
  }
});

// ---------------------------------------------------------------------------
// AC2: event whose 11:59pm local cutoff has passed -> 400 SALES_CLOSED
// ---------------------------------------------------------------------------
test('AC2 - create-payment-intent returns 400 SALES_CLOSED when event day has fully passed', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  // Event started 2 days ago - its 11:59pm cutoff has definitely passed.
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  const event = await createPaidEvent(organiser, {
    dateTime: twoDaysAgo,
    timeZone: 'UTC',
    expiryDate: new Date(Date.now() + 5 * 24 * 3600 * 1000), // still within grace
  });
  const ticketTypeId = event.ticketTypes[0]._id.toString();

  const res = await request(app)
    .post(`/api/events/${event._id}/paid/create-payment-intent`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(buyer))
    .send({ tickets: ticketsFor(ticketTypeId), buyerInfo: BUYER });

  expect(res.status).toBe(400);
  expect(res.body.errorCode).toBe('SALES_CLOSED');
  expect(res.body.message).toMatch(/Ticket sales for this event have closed/i);
});

// ---------------------------------------------------------------------------
// AC3: cutoff is computed in the event's own timezone (unit test via injectable now)
// ---------------------------------------------------------------------------
test('AC3 - isSalesOpen uses event timezone, not server/UTC day', () => {
  // Scenario: event dateTime = yesterday 20:00 UTC. In Australia/Perth (UTC+8) that is
  // yesterday 04:00+1day = today 04:00 Perth. The 11:59pm Perth cutoff for this event is
  // today 11:59pm Perth = today 15:59 UTC. If "now" is 14:00 UTC = 22:00 Perth, sales are OPEN.
  // In pure UTC terms yesterday 20:00 UTC is clearly "yesterday UTC", so a UTC-only check
  // would see it as closed - but the Perth cutoff hasn't passed yet.

  const utcYesterday20 = new Date(Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate() - 1, // yesterday UTC
    20, 0, 0
  ));
  const perthEvent = { dateTime: utcYesterday20, timeZone: 'Australia/Perth' };

  // 14:00 UTC today = 22:00 Perth today (the event's local day cutoff 23:59 Perth hasn't passed).
  const nowAt14UTC = new Date(Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
    14, 0, 0
  ));
  expect(isSalesOpen(perthEvent, nowAt14UTC)).toBe(true);

  // 16:30 UTC today = 00:30 next day Perth - cutoff HAS passed -> CLOSED.
  const nowAt1630UTC = new Date(Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
    16, 30, 0
  ));
  expect(isSalesOpen(perthEvent, nowAt1630UTC)).toBe(false);

  // Sanity: a UTC-only cutoff would have read yesterday 20:00 UTC as "yesterday" and returned
  // CLOSED for the 14:00 UTC check above. Our timezone-aware helper correctly returns OPEN.
});

// ---------------------------------------------------------------------------
// AC4: confirm-payment after the cutoff is refused with SALES_CLOSED
// ---------------------------------------------------------------------------
test('AC4 - confirm-payment returns SALES_CLOSED for event past its cutoff', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  const event = await createPaidEvent(organiser, {
    dateTime: twoDaysAgo,
    timeZone: 'UTC',
    expiryDate: new Date(Date.now() + 5 * 24 * 3600 * 1000),
  });
  const ticketTypeId = event.ticketTypes[0]._id.toString();

  // The early cutoff guard in confirmPayment runs before Stripe retrieval, so any
  // paymentIntentId string triggers it and we get SALES_CLOSED without a Stripe call.
  const res = await request(app)
    .post(`/api/events/${event._id}/paid/confirm-payment`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(buyer))
    .send({
      paymentIntentId: 'pi_test_stale',
      tickets: ticketsFor(ticketTypeId),
      buyerInfo: BUYER,
    });

  expect(res.status).toBe(400);
  expect(res.body.errorCode).toBe('SALES_CLOSED');
});

// ---------------------------------------------------------------------------
// AC5: creating (and updating) a reservation for a closed event is refused
// ---------------------------------------------------------------------------
test('AC5 - reservation create is refused with SALES_CLOSED when event day has passed', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  const event = await createPaidEvent(organiser, {
    dateTime: twoDaysAgo,
    timeZone: 'UTC',
    expiryDate: new Date(Date.now() + 5 * 24 * 3600 * 1000),
  });
  const ticketTypeId = event.ticketTypes[0]._id.toString();

  const res = await request(app)
    .post(`/api/events/${event._id}/reservation`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(buyer))
    .send({ tickets: [{ ticketTypeId, quantity: 1 }] });

  expect(res.status).toBe(400);
  expect(res.body.errorCode).toBe('SALES_CLOSED');
});

test('AC5b - reservation create succeeds for an event before its cutoff', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const startedAMomentAgo = new Date(Date.now() - 1000);
  const event = await createPaidEvent(organiser, {
    dateTime: startedAMomentAgo,
    timeZone: 'UTC',
    capacity: 100,
  });
  const ticketTypeId = event.ticketTypes[0]._id.toString();

  const res = await request(app)
    .post(`/api/events/${event._id}/reservation`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(buyer))
    .send({ tickets: [{ ticketTypeId, quantity: 1 }] });

  // Reservation should succeed (sales are still open).
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
});

// ---------------------------------------------------------------------------
// AC6: sales cutoff is independent of the 5-day past-grace (expiryDate)
// ---------------------------------------------------------------------------
test('AC6 - event past sales cutoff but within expiryDate grace reads sales-closed not past', () => {
  // isSalesOpen returns false once the event day has passed, regardless of expiryDate.
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  const event = {
    dateTime: twoDaysAgo,
    timeZone: 'UTC',
    expiryDate: new Date(Date.now() + 5 * 24 * 3600 * 1000), // still within grace
  };

  expect(isSalesOpen(event)).toBe(false);
  // expiryDate is still in the future - it's not "past" by the legacy definition.
  expect(new Date(event.expiryDate) > new Date()).toBe(true);
});

// ---------------------------------------------------------------------------
// AC7: full event past its sales cutoff - waitlist join is refused
// ---------------------------------------------------------------------------
test('AC7 - waitlist join is refused with SALES_CLOSED for a full paid event past its cutoff', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  // capacity: 0 means unlimited so we can't hit "full"; use capacity:1 and no tickets sold.
  // The waitlist controller checks sold >= capacity first; we short-circuit with SALES_CLOSED
  // before that for paid events.
  const event = await createPaidEvent(organiser, {
    dateTime: twoDaysAgo,
    timeZone: 'UTC',
    expiryDate: new Date(Date.now() + 5 * 24 * 3600 * 1000),
    capacity: 1,
    waitlistEnabled: true,
  });

  const res = await request(app)
    .post(`/api/events/${event._id}/waitlist/join`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(buyer))
    .send({});

  expect(res.status).toBe(400);
  expect(res.body.errorCode).toBe('SALES_CLOSED');
});
