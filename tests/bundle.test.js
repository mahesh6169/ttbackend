// Proves the bundle ticket price feature — see featureplans/events-bundle-ticket.md.
// A bundle type stores the PER-PERSON share as price + a bundleSize; buyers must purchase whole
// packs (quantity a multiple of N); every downstream money path is untouched.
// AC12 (issuance: 4 tickets @ $18, one invoice $72, refund max $18) and AC14 (capacity falls by 4)
// require a completed real payment and are proven from DB state in ttfrontend/e2e/bundle.spec.js.
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../app.js';
import Event from '../models/eventModel.js';
import PaidTicket from '../models/paidTicket.js';
import { createEventSnapshot, calculateCurrentTicketsSold } from '../utils/events/ticketHelpers.js';
import { applyRefundSuccessData } from '../utils/events/refundHelpers.js';
import { createOrganiser, createUser, cookieFor, API_KEY } from './helpers/factories.js';

const FUTURE = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const ADDRESS = JSON.stringify({
  formattedAddress: '1 Test St, Sydney NSW 2000',
  suburb: 'Sydney',
  state: 'NSW',
  location: { type: 'Point', coordinates: [151.2093, -33.8688] },
});

// POST the real add-paid-event endpoint (multipart, like the wizard). Ticket types are sent with
// the BUNDLE price the organiser typed (price: 72, bundleSize: 4); the server stores the share.
const addPaidEvent = (organiser, overrides = {}) => {
  const {
    ticketTypes = [{ name: 'FamilyFour', price: 72, bundleSize: 4 }],
    maxAttendeesPerRegistration = 10,
    capacity = 100,
    discountCodes,
  } = overrides;
  const req = request(app)
    .post('/api/events/add-paid-event')
    .set('Cookie', cookieFor(organiser))
    .set('x-api-key', API_KEY)
    .field('title', 'Bundle Test Event')
    .field('dateTime', FUTURE())
    .field('venue', 'Test Hall')
    .field('description', 'A seeded paid event for bundle tests.')
    .field('category', 'Community')
    .field('address', ADDRESS)
    .field('organizer', JSON.stringify({ name: 'Test Organiser' }))
    .field('ticketTypes', JSON.stringify(ticketTypes))
    .field('capacity', String(capacity))
    .field('maxAttendeesPerRegistration', String(maxAttendeesPerRegistration));
  if (discountCodes) req.field('discountCodes', JSON.stringify(discountCodes));
  return req;
};

const updatePaidEvent = (organiser, eventId, overrides = {}) => {
  const {
    ticketTypes = [{ name: 'FamilyFour', price: 72, bundleSize: 4 }],
    maxAttendeesPerRegistration = 10,
    capacity = 100,
  } = overrides;
  return request(app)
    .put(`/api/events/update-paid/${eventId}`)
    .set('Cookie', cookieFor(organiser))
    .set('x-api-key', API_KEY)
    .field('title', 'Bundle Test Event')
    .field('dateTime', FUTURE())
    .field('venue', 'Test Hall')
    .field('description', 'A seeded paid event for bundle tests.')
    .field('category', 'Community')
    .field('address', ADDRESS)
    .field('organizer', JSON.stringify({ name: 'Test Organiser' }))
    .field('ticketTypes', JSON.stringify(ticketTypes))
    .field('capacity', String(capacity))
    .field('maxAttendeesPerRegistration', String(maxAttendeesPerRegistration));
};

const reserve = (member, eventId, tickets) =>
  request(app)
    .post(`/api/events/${eventId}/reservation`)
    .set('Cookie', cookieFor(member))
    .set('x-api-key', API_KEY)
    .send({ tickets });

const BUYER = { email: 'buyer@test.dev', firstName: 'Bella', lastName: 'Buyer' };

// ─── [api] Saving and editing ────────────────────────────────────────────────

test('AC1 saving a bundle stores the PACK price as typed + bundleSize, and the snapshot carries it', async () => {
  const organiser = await createOrganiser();
  const res = await addPaidEvent(organiser, {
    ticketTypes: [{ name: 'FamilyFour', price: 72, bundleSize: 4 }],
  });
  expect(res.status).toBe(201);

  const event = await Event.findById(res.body.event._id);
  const ft = event.ticketTypes.find((t) => t.name === 'FamilyFour');
  expect(ft.price).toBe(72);       // the pack price, stored as typed (no division)
  expect(ft.bundleSize).toBe(4);

  // The event snapshot copied into paperwork self-describes the bundle.
  const snap = createEventSnapshot(event);
  const snapType = snap.ticketTypes.find((t) => t.name === 'FamilyFour');
  expect(snapType.bundleSize).toBe(4);
  expect(snapType.price).toBe(72);
});

test('AC2 a bundle price that does not divide evenly by size is now accepted (divides-evenly rule removed)', async () => {
  const organiser = await createOrganiser();
  const res = await addPaidEvent(organiser, {
    ticketTypes: [{ name: 'FamilyFour', price: 70, bundleSize: 4 }],
  });
  expect(res.status).toBe(201);
  const event = await Event.findById(res.body.event._id);
  expect(event.ticketTypes.find((t) => t.name === 'FamilyFour').price).toBe(70);
});

test('AC3 a bundle whose per-person share is under $1 is rejected', async () => {
  const organiser = await createOrganiser();
  const res = await addPaidEvent(organiser, {
    ticketTypes: [{ name: 'FamilyFour', price: 3, bundleSize: 4 }],
  });
  expect(res.status).toBe(400);
});

test('AC4 a bundle larger than max-per-registration is rejected at save', async () => {
  const organiser = await createOrganiser();
  const res = await addPaidEvent(organiser, {
    ticketTypes: [{ name: 'FamilyFour', price: 72, bundleSize: 4 }],
    maxAttendeesPerRegistration: 3,
  });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/per order|bundle/i);
});

test('AC5 lowering max-per-registration below a live bundle size is rejected on edit', async () => {
  const organiser = await createOrganiser();
  const created = await addPaidEvent(organiser, {
    ticketTypes: [{ name: 'FamilyFour', price: 72, bundleSize: 4 }],
    maxAttendeesPerRegistration: 10,
  });
  expect(created.status).toBe(201);

  const res = await updatePaidEvent(organiser, created.body.event._id, {
    ticketTypes: [{ name: 'FamilyFour', price: 72, bundleSize: 4 }],
    maxAttendeesPerRegistration: 3,
  });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/per order|bundle/i);
});

test('AC6 a normal type saved alongside a bundle behaves exactly as today', async () => {
  const organiser = await createOrganiser();
  const res = await addPaidEvent(organiser, {
    ticketTypes: [
      { name: 'FamilyFour', price: 72, bundleSize: 4 },
      { name: 'General', price: 25 },
    ],
  });
  expect(res.status).toBe(201);
  const event = await Event.findById(res.body.event._id);
  const general = event.ticketTypes.find((t) => t.name === 'General');
  const family = event.ticketTypes.find((t) => t.name === 'FamilyFour');
  expect(general.price).toBe(25);
  expect(general.bundleSize).toBeUndefined();
  expect(family.price).toBe(72);   // pack price stored as typed
  expect(family.bundleSize).toBe(4);
});

// ─── [api] The multiples wall ────────────────────────────────────────────────

test('AC7 a bundle reservation must be a whole number of packs', async () => {
  const organiser = await createOrganiser();
  const member = await createUser();
  const created = await addPaidEvent(organiser);
  const ftId = created.body.event.ticketTypes.find((t) => t.name === 'FamilyFour')._id;
  const eventId = created.body.event._id;

  const ok = await reserve(member, eventId, [{ ticketTypeId: ftId, quantity: 4 }]);
  expect(ok.status).toBe(200);

  const two = await reserve(member, eventId, [{ ticketTypeId: ftId, quantity: 2 }]);
  expect(two.status).toBe(400);
  expect(two.body.message).toMatch(/pack|multiple/i);

  const six = await reserve(member, eventId, [{ ticketTypeId: ftId, quantity: 6 }]);
  expect(six.status).toBe(400);
});

test('AC8 a reservation that predates a bundle-size edit is rejected at payment revalidation', async () => {
  const organiser = await createOrganiser();
  const member = await createUser();
  const created = await addPaidEvent(organiser);
  const eventId = created.body.event._id;
  const ftId = created.body.event.ticketTypes.find((t) => t.name === 'FamilyFour')._id;

  // Buyer holds a valid pack of 4 under the original size.
  const held = await reserve(member, eventId, [{ ticketTypeId: ftId, quantity: 4 }]);
  expect(held.status).toBe(200);

  // Organiser edits the bundle size to 5 — the held 4 is now an invalid multiple.
  await Event.updateOne({ _id: eventId }, { $set: { 'ticketTypes.0.bundleSize': 5 } });

  const pay = await request(app)
    .post(`/api/events/${eventId}/paid/create-payment-intent`)
    .set('Cookie', cookieFor(member))
    .set('x-api-key', API_KEY)
    .send({ tickets: { [ftId]: 4 }, buyerInfo: BUYER });
  expect(pay.status).toBe(400);
  expect(pay.body.message).toMatch(/pack|multiple/i);
});

test('AC9 two bundle types in one cart validate multiples independently; totals are correct', async () => {
  const organiser = await createOrganiser();
  const member = await createUser();
  const created = await addPaidEvent(organiser, {
    ticketTypes: [
      { name: 'FamilyFour', price: 72, bundleSize: 4 }, // share 18
      { name: 'CoupleTwo', price: 40, bundleSize: 2 },  // share 20
    ],
  });
  const eventId = created.body.event._id;
  const ffId = created.body.event.ticketTypes.find((t) => t.name === 'FamilyFour')._id;
  const ctId = created.body.event.ticketTypes.find((t) => t.name === 'CoupleTwo')._id;

  const both = await reserve(member, eventId, [
    { ticketTypeId: ffId, quantity: 4 },
    { ticketTypeId: ctId, quantity: 2 },
  ]);
  expect(both.status).toBe(200);
  expect(both.body.totalAmount).toBe(112); // 18*4 + 20*2

  const badCouple = await reserve(member, eventId, [
    { ticketTypeId: ffId, quantity: 4 },
    { ticketTypeId: ctId, quantity: 3 },
  ]);
  expect(badCouple.status).toBe(400);

  const badFamily = await reserve(member, eventId, [
    { ticketTypeId: ffId, quantity: 2 },
    { ticketTypeId: ctId, quantity: 2 },
  ]);
  expect(badFamily.status).toBe(400);
});

// ─── [api] Money ─────────────────────────────────────────────────────────────

test('AC10 one pack reserves at $72 and a two-pack payment intent prices $144', async () => {
  const organiser = await createOrganiser();
  const member = await createUser();
  const created = await addPaidEvent(organiser);
  const eventId = created.body.event._id;
  const ftId = created.body.event.ticketTypes.find((t) => t.name === 'FamilyFour')._id;

  const one = await reserve(member, eventId, [{ ticketTypeId: ftId, quantity: 4 }]);
  expect(one.status).toBe(200);
  expect(one.body.totalAmount).toBe(72);

  const pay = await request(app)
    .post(`/api/events/${eventId}/paid/create-payment-intent`)
    .set('Cookie', cookieFor(member))
    .set('x-api-key', API_KEY)
    .send({ tickets: { [ftId]: 8 }, buyerInfo: BUYER });
  expect(pay.status).toBe(200);
  expect(pay.body.pricing.total).toBe(144);
});

test('AC11 a percent code covering a bundle discounts on the shares; a share-below-$1 code is rejected at save', async () => {
  const organiser = await createOrganiser();
  const member = await createUser();
  const created = await addPaidEvent(organiser, {
    ticketTypes: [{ name: 'FamilyFour', price: 72, bundleSize: 4 }],
    discountCodes: [
      { code: 'FAM10', kind: 'percent', value: 10, appliesToTicketTypes: ['FamilyFour'], active: true, showHint: false },
    ],
  });
  expect(created.status).toBe(201);
  const eventId = created.body.event._id;
  const ftId = created.body.event.ticketTypes.find((t) => t.name === 'FamilyFour')._id;

  const pay = await request(app)
    .post(`/api/events/${eventId}/paid/create-payment-intent`)
    .set('Cookie', cookieFor(member))
    .set('x-api-key', API_KEY)
    .send({ tickets: { [ftId]: 4 }, buyerInfo: BUYER, discountCode: 'FAM10' });
  expect(pay.status).toBe(200);
  expect(pay.body.pricing.discountAmount).toBe(7.2); // 10% of the $72 pack = $7.20

  // A fixed $72 code off the $72 pack would drop each person's $18 share to $0 — rejected at save
  // (the $1-per-person floor; a fixed amount reduces each share by value / size).
  const bad = await addPaidEvent(organiser, {
    ticketTypes: [{ name: 'FamilyFour', price: 72, bundleSize: 4 }],
    discountCodes: [
      { code: 'TOODEEP', kind: 'fixed', value: 72, appliesToTicketTypes: ['FamilyFour'], active: true, showHint: false },
    ],
  });
  expect(bad.status).toBe(400);
  expect(bad.body.message).toMatch(/\$1 minimum|under \$1/i);
});

// ─── [api] Capacity ──────────────────────────────────────────────────────────

test('AC13 a pack that does not fit the remaining capacity is rejected with the not-enough message', async () => {
  const organiser = await createOrganiser();
  const member = await createUser();
  const created = await addPaidEvent(organiser, {
    ticketTypes: [{ name: 'FamilyFour', price: 72, bundleSize: 4 }],
    capacity: 3, // only 3 spots — a pack of 4 cannot fit
  });
  const eventId = created.body.event._id;
  const ftId = created.body.event.ticketTypes.find((t) => t.name === 'FamilyFour')._id;

  const res = await reserve(member, eventId, [{ ticketTypeId: ftId, quantity: 4 }]);
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/available|remaining|reduce/i);
});

// ─── Capacity releases on a full refund (was the KNOWN-capacity marker; now a normal assertion) ──
// The bundle build recorded this as a finding; fix-events-refund-capacity-release.md settled it. A
// FULL refund cancels the ticket via the real refund engine, so it stops consuming capacity. Full
// coverage (partial keeps its spot, door refusal, per-member packs) lives in tests/refundCapacity.test.js.
test('a fully-refunded ticket stops consuming capacity', async () => {
  const organiser = await createOrganiser();
  const eventId = new mongoose.Types.ObjectId().toString();
  const base = {
    event: eventId,
    invoiceNumber: 'INV-FIND-0001',
    user: organiser._id,
    priceDetails: { basePrice: 18, totalPrice: 18 },
    refundPolicyAcceptance: { policyType: 'non-refundable', accepted: true },
    checkInStatus: 'confirmed',
    refundStatus: 'none',
    totalRefundedAmount: 0,
  };
  await PaidTicket.create({ ...base, ticketNumber: 'TKT-FIND-0001' });
  const refunded = await PaidTicket.create({ ...base, ticketNumber: 'TKT-FIND-0002' });
  expect(await calculateCurrentTicketsSold(eventId)).toBe(2);

  // Full refund through the real engine cancels the ticket -> it no longer consumes capacity.
  await applyRefundSuccessData(
    null,
    { refundAmounts: new Map([[refunded.ticketNumber, 18]]), stripeRefundId: 're_t', refundRequestId: 'REF-T', reason: '', totalAmount: 18 },
    [refunded],
    { amounts: { total: 36, totalRefunded: 0, netAmount: 36 }, refunds: [], status: 'paid', save: async () => {} },
    organiser._id
  );

  expect(await calculateCurrentTicketsSold(eventId)).toBe(1);
});
