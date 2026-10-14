// Activity-based edit locking - see featureplans/events-edit-locking.md.
// Stage 1 (signals): the server flips hasActivity / hasSeating / a ticket type's hasSold at the
// moment activity happens, and the owner edit-load returns those plus a committed count and (for
// seated events) per-seat status. Test titles carry the AC numbers.
// NOTE: the PAID first-sale flag-set lives inside confirmPayment (real Stripe), which the backend
// suite never drives - like bundle.test.js's AC12/AC14, that assertion is proven in the e2e spec
// (editlocking.spec.js) against a real purchase. Here we cover the free-RSVP hook, the layout-save
// hook, and the edit-load payload directly over HTTP.
import request from 'supertest';
import app from '../app.js';
import Event from '../models/eventModel.js';
import PaidTicket from '../models/paidTicket.js';
import {
  createOrganiser, createUser, createFreeEvent, createPaidEvent, cookieFor, API_KEY,
} from './helpers/factories.js';
import { getCapturedEmails, clearCapturedEmails } from '../utils/notifications/sendEmail.js';
import { validateTicketPurchase } from '../utils/events/ticketHelpers.js';

// Poll briefly for a captured email - the update endpoint fires the notification fire-and-forget.
const waitForEmail = async (match, tries = 30, ms = 50) => {
  for (let i = 0; i < tries; i++) {
    const hit = getCapturedEmails().find(match);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, ms));
  }
  return getCapturedEmails().find(match);
};

const FUTURE = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const ADDRESS = JSON.stringify({
  formattedAddress: '1 Test St, Sydney NSW 2000',
  suburb: 'Sydney', state: 'NSW',
  location: { type: 'Point', coordinates: [151.2093, -33.8688] },
});

// A plain seated grid the way the builder submits it (seatId = rowLabel-seatNumber).
const grid = (rowLabels, seatsPerRow, bookedSeatId = null) =>
  rowLabels.map((label) => ({
    rowLabel: label,
    walkwayPositions: [],
    seats: Array.from({ length: seatsPerRow }, (_, i) => {
      const seatNumber = String(i + 1);
      const seatId = `${label}-${seatNumber}`;
      return { seatId, seatNumber, row: label, status: seatId === bookedSeatId ? 'booked' : 'available' };
    }),
  }));

// PUT the real update-paid endpoint (multipart, like the wizard).
const updatePaid = (organiser, eventId, {
  seatingLayout, capacity = 100, ticketTypes = [{ name: 'Standard', price: 10 }],
  discountCodes, registrationFields, isAdvertiseOnly,
} = {}) => {
  const req = request(app)
    .put(`/api/events/update-paid/${eventId}`)
    .set('Cookie', cookieFor(organiser))
    .set('x-api-key', API_KEY)
    .field('title', 'Edit Lock Test')
    .field('dateTime', FUTURE())
    .field('venue', 'Test Hall')
    .field('description', 'A seeded paid event for edit-locking tests.')
    .field('category', 'Community')
    .field('address', ADDRESS)
    .field('organizer', JSON.stringify({ name: 'Test Organiser' }))
    .field('ticketTypes', JSON.stringify(ticketTypes))
    .field('capacity', String(capacity))
    .field('maxAttendeesPerRegistration', '10')
    .field('seatingLayout', JSON.stringify(seatingLayout || []));
  if (discountCodes !== undefined) req.field('discountCodes', JSON.stringify(discountCodes));
  if (registrationFields !== undefined) req.field('registrationFields', JSON.stringify(registrationFields));
  if (isAdvertiseOnly !== undefined) req.field('isAdvertiseOnly', String(isAdvertiseOnly));
  return req;
};

// PUT the real update-free endpoint (multipart).
const updateFree = (organiser, eventId, { capacity = 100, registrationFields, venue = 'Test Hall' } = {}) => {
  const req = request(app)
    .put(`/api/events/update-free/${eventId}`)
    .set('Cookie', cookieFor(organiser))
    .set('x-api-key', API_KEY)
    .field('title', 'Edit Lock Free Test')
    .field('dateTime', FUTURE())
    .field('venue', venue)
    .field('description', 'A seeded free event for edit-locking tests.')
    .field('category', 'Community')
    .field('address', ADDRESS)
    .field('organizer', JSON.stringify({ name: 'Test Organiser' }))
    .field('isPaid', 'false')
    .field('capacity', String(capacity))
    .field('maxAttendeesPerRegistration', '10');
  if (registrationFields !== undefined) req.field('registrationFields', JSON.stringify(registrationFields));
  return req;
};

let tn = 0;
const uniqueTn = () => `TN-EL-${Date.now().toString(36)}-${tn++}`;
// A confirmed PaidTicket straight into the DB (no Stripe) - it is what calculateCurrentTicketsSold counts.
const issueTicket = (event, organiser, buyer) =>
  PaidTicket.create({
    event: event._id.toString(),
    ticketNumber: uniqueTn(),
    invoiceNumber: 'INV-EL-0001',
    user: buyer._id,
    eventSnapshot: { eventCode: event.eventCode, title: event.title, postedBy: organiser._id.toString() },
    ticketType: { name: 'Standard', price: 10 },
    priceDetails: { basePrice: 10, totalPrice: 10 },
    buyer: { firstName: 'Bella', lastName: 'Buyer', email: buyer.email, agreedToTerms: true },
    attendees: [{ name: 'Bella Buyer' }],
    refundPolicyAcceptance: { policyType: 'non-refundable', accepted: true },
    checkInStatus: 'confirmed',
    refundStatus: 'none',
    totalRefundedAmount: 0,
  });

test('AC1 a first free RSVP flips event.hasActivity', async () => {
  const organiser = await createOrganiser();
  const member = await createUser({ email: 'el-rsvp@test.dev' });
  const event = await createFreeEvent(organiser, { capacity: 100 });

  expect(event.hasActivity).toBe(false); // clean event

  const res = await request(app)
    .post(`/api/events/${event._id}/free/register`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(member))
    .send({ mobile: '0412345678', attendees: [{ name: 'Racer' }] });
  expect(res.status).toBeLessThan(400);

  const after = await Event.findById(event._id);
  expect(after.hasActivity).toBe(true);
});

test('AC1 saving a non-empty seat layout flips event.hasSeating', async () => {
  const organiser = await createOrganiser();
  const event = await createPaidEvent(organiser, { capacity: 100 }); // no layout yet

  expect(event.hasSeating).toBe(false);

  const res = await updatePaid(organiser, event._id, { seatingLayout: grid(['A', 'B'], 5) });
  expect(res.status).toBe(200);

  const after = await Event.findById(event._id);
  expect(after.hasSeating).toBe(true);
});

test('AC1 the owner edit-load returns the signals, the committed count, and per-seat status', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser({ email: 'el-buyer@test.dev' });
  const event = await createPaidEvent(organiser, {
    capacity: 100,
    hasActivity: true,
    hasSeating: true,
    ticketTypes: [{ name: 'Standard', price: 10, hasSold: true }],
    seatingLayout: grid(['A'], 5, 'A-1'), // A-1 booked
  });
  await issueTicket(event, organiser, buyer); // committed count = 1

  const res = await request(app)
    .get(`/api/events/views/${event._id}`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(organiser)); // owner load
  expect(res.status).toBe(200);

  expect(res.body.hasActivity).toBe(true);
  expect(res.body.hasSeating).toBe(true);
  expect(res.body.ticketTypes[0].hasSold).toBe(true);
  expect(res.body.committedCount).toBe(1);
  // per-seat status rides along on the layout
  const a1 = res.body.seatingLayout[0].seats.find((s) => s.seatId === 'A-1');
  expect(a1.status).toBe('booked');
});

// --- Always-locked and no-activity (D7, D1) ---

test('AC2 the update endpoint rejects changing the event type', async () => {
  const organiser = await createOrganiser();
  const event = await createFreeEvent(organiser, { capacity: 100 }); // a FREE event
  // Push it through the PAID update endpoint - a genuine free -> paid type change. Locked (D7).
  const res = await updatePaid(organiser, event._id, { ticketTypes: [{ name: 'Standard', price: 10 }] });
  expect(res.status).toBe(409);
  expect(res.body.message).toMatch(/event type/i);
});

test('AC3 an event with no activity is fully editable - nothing is locked', async () => {
  const organiser = await createOrganiser();
  const event = await createPaidEvent(organiser, {
    capacity: 100,
    ticketTypes: [{ name: 'Standard', price: 10 }],
    discountCodes: [{ code: 'SAVE10', kind: 'percent', value: 10, active: true, appliesToTicketTypes: ['Standard'] }],
    registrationFields: [{ fieldName: 'Diet', fieldType: 'text', isRequired: false }],
  });
  // Rename + reprice the type, rewrite the code, edit the question, add a new type - all allowed.
  const res = await updatePaid(organiser, event._id, {
    ticketTypes: [{ name: 'VIP', price: 25 }, { name: 'General', price: 15 }],
    discountCodes: [{ code: 'SAVE20', kind: 'percent', value: 20, active: true, appliesToTicketTypes: ['VIP'] }],
    registrationFields: [{ fieldName: 'Meal choice', fieldType: 'text', isRequired: true }],
  });
  expect(res.status).toBe(200);
  const after = await Event.findById(event._id);
  expect(after.ticketTypes.map((t) => t.name).sort()).toEqual(['General', 'VIP']);
});

// --- Ticket types (hasSold) ---

test('AC4 update rejects changing or deleting a sold ticket type', async () => {
  const organiser = await createOrganiser();
  const seed = () => createPaidEvent(organiser, {
    capacity: 100, hasActivity: true,
    ticketTypes: [{ name: 'Standard', price: 10, hasSold: true }],
  });

  const e1 = await seed();
  const rPrice = await updatePaid(organiser, e1._id, { ticketTypes: [{ name: 'Standard', price: 20 }] });
  expect(rPrice.status).toBe(409);
  expect(rPrice.body.message).toMatch(/price/i);

  const e2 = await seed();
  const rName = await updatePaid(organiser, e2._id, { ticketTypes: [{ name: 'VIP', price: 10 }] });
  expect(rName.status).toBe(409); // renamed -> sold name missing

  const e3 = await seed();
  const rBundle = await updatePaid(organiser, e3._id, { ticketTypes: [{ name: 'Standard', price: 10, bundleSize: 2 }] });
  expect(rBundle.status).toBe(409);
  expect(rBundle.body.message).toMatch(/bundle/i);

  const e4 = await seed();
  const rDelete = await updatePaid(organiser, e4._id, { ticketTypes: [{ name: 'Other', price: 10 }] });
  expect(rDelete.status).toBe(409); // Standard deleted
});

test('AC5 an unsold ticket type is fully editable and deletable; adding is always accepted', async () => {
  const organiser = await createOrganiser();
  const event = await createPaidEvent(organiser, {
    capacity: 100,
    ticketTypes: [{ name: 'Standard', price: 10 }, { name: 'Spare', price: 12 }],
  });
  // Rename + reprice Standard, DELETE Spare, ADD a brand new type - all allowed (nothing sold).
  const res = await updatePaid(organiser, event._id, {
    ticketTypes: [{ name: 'VIP', price: 30 }, { name: 'EarlyBird', price: 8 }],
  });
  expect(res.status).toBe(200);
  const after = await Event.findById(event._id);
  expect(after.ticketTypes.map((t) => t.name).sort()).toEqual(['EarlyBird', 'VIP']);
});

// --- Discount codes (usedCount) ---

test('AC7 update rejects changing or deleting a USED code; an unused code is free', async () => {
  const organiser = await createOrganiser();
  const usedSeed = () => createPaidEvent(organiser, {
    capacity: 100, hasActivity: true,
    ticketTypes: [{ name: 'Standard', price: 10 }, { name: 'VIP', price: 20 }],
    discountCodes: [{ code: 'SAVE10', kind: 'percent', value: 10, usedCount: 1, active: true, appliesToTicketTypes: ['Standard'] }],
  });

  const e1 = await usedSeed();
  const rVal = await updatePaid(organiser, e1._id, {
    ticketTypes: [{ name: 'Standard', price: 10 }, { name: 'VIP', price: 20 }],
    discountCodes: [{ code: 'SAVE10', kind: 'percent', value: 25, active: true, appliesToTicketTypes: ['Standard'] }],
  });
  expect(rVal.status).toBe(409);

  const e2 = await usedSeed();
  const rApplies = await updatePaid(organiser, e2._id, {
    ticketTypes: [{ name: 'Standard', price: 10 }, { name: 'VIP', price: 20 }],
    discountCodes: [{ code: 'SAVE10', kind: 'percent', value: 10, active: true, appliesToTicketTypes: ['VIP'] }],
  });
  expect(rApplies.status).toBe(409);

  const e3 = await usedSeed();
  const rDelete = await updatePaid(organiser, e3._id, {
    ticketTypes: [{ name: 'Standard', price: 10 }, { name: 'VIP', price: 20 }],
    discountCodes: [], // dropped the used code
  });
  expect(rDelete.status).toBe(409);

  // An UNUSED code can be fully rewritten.
  const e4 = await createPaidEvent(organiser, {
    capacity: 100,
    ticketTypes: [{ name: 'Standard', price: 10 }],
    discountCodes: [{ code: 'FREEBIE', kind: 'percent', value: 10, usedCount: 0, active: true, appliesToTicketTypes: ['Standard'] }],
  });
  const rFree = await updatePaid(organiser, e4._id, {
    ticketTypes: [{ name: 'Standard', price: 10 }],
    discountCodes: [{ code: 'NEWCODE', kind: 'fixed', value: 2, active: true, appliesToTicketTypes: ['Standard'] }],
  });
  expect(rFree.status).toBe(200);
});

test('AC8 a used code max-uses can be raised, not set below used; window + deactivate stay editable', async () => {
  const organiser = await createOrganiser();
  const seed = () => createPaidEvent(organiser, {
    capacity: 100, hasActivity: true,
    ticketTypes: [{ name: 'Standard', price: 10 }],
    discountCodes: [{ code: 'SAVE10', kind: 'percent', value: 10, usedCount: 2, maxUses: 5, remainingUses: 3, active: true, appliesToTicketTypes: ['Standard'] }],
  });

  const eLow = await seed();
  const rLow = await updatePaid(organiser, eLow._id, {
    ticketTypes: [{ name: 'Standard', price: 10 }],
    discountCodes: [{ code: 'SAVE10', kind: 'percent', value: 10, maxUses: 1, active: true, appliesToTicketTypes: ['Standard'] }],
  });
  expect(rLow.status).toBeGreaterThanOrEqual(400); // 2 already used, floor is 2

  const eOk = await seed();
  const rOk = await updatePaid(organiser, eOk._id, {
    ticketTypes: [{ name: 'Standard', price: 10 }],
    discountCodes: [{ code: 'SAVE10', kind: 'percent', value: 10, maxUses: 10, active: false, validUntil: FUTURE(), appliesToTicketTypes: ['Standard'] }],
  });
  expect(rOk.status).toBe(200);
  const after = await Event.findById(eOk._id);
  const code = after.discountCodes.find((c) => c.code === 'SAVE10');
  expect(code.maxUses).toBe(10);
  expect(code.active).toBe(false); // deactivate stayed editable
});

// --- Capacity (committed count) ---

test('AC9 update refuses capacity below the committed count; increasing is accepted (fresh count at save)', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser({ email: 'el-cap@test.dev' });
  const event = await createPaidEvent(organiser, {
    capacity: 100, hasActivity: true, ticketTypes: [{ name: 'Standard', price: 10 }],
  });
  for (let i = 0; i < 5; i++) await issueTicket(event, organiser, buyer); // committed = 5

  const rLow = await updatePaid(organiser, event._id, { capacity: 3 });
  expect(rLow.status).toBe(409);
  expect(rLow.body.message).toMatch(/capacity/i);

  const rUp = await updatePaid(organiser, event._id, { capacity: 200 });
  expect(rUp.status).toBe(200);
  const after = await Event.findById(event._id);
  expect(after.capacity).toBe(200);
});

// --- Seated editing (per-seat status) ---

test('AC13 once a seat sells the layout is frozen; only reserving/releasing free seats stays live', async () => {
  const org = await createOrganiser();
  const seed = () => createPaidEvent(org, { capacity: 20, seatingLayout: grid(['A', 'B'], 5, 'A-3') }); // A-3 booked

  // Every STRUCTURAL change is now refused (the hall is fixed once a seat sells):
  const eClear = await seed();
  expect((await updatePaid(org, eClear._id, { seatingLayout: [], capacity: 20 })).status).toBe(409); // clear
  const eResize = await seed();
  expect((await updatePaid(org, eResize._id, { seatingLayout: grid(['A', 'B'], 2), capacity: 20 })).status).toBe(409); // resize a row
  const eAddRow = await seed();
  expect((await updatePaid(org, eAddRow._id, { seatingLayout: grid(['A', 'B', 'C'], 5, 'A-3'), capacity: 25 })).status).toBe(409); // add a row
  const eAppend = await seed();
  const appendLayout = grid(['A', 'B'], 5, 'A-3');
  appendLayout[0].seats.push({ seatId: 'A-6', seatNumber: '6', row: 'A', status: 'available' });
  expect((await updatePaid(org, eAppend._id, { seatingLayout: appendLayout, capacity: 21 })).status).toBe(409); // append a seat

  // Disturbing the SOLD seat (A-3 -> reserved) is refused.
  const eResv = await seed();
  const toReserved = grid(['A', 'B'], 5);
  toReserved[0].seats[2].status = 'reserved'; // A-3
  expect((await updatePaid(org, eResv._id, { seatingLayout: toReserved, capacity: 20 })).status).toBe(409);

  // Reserving an UNBOOKED free seat (A-1) is accepted - a seat-status change, not a structure change.
  const eResvOk = await seed();
  const reserveUnbooked = grid(['A', 'B'], 5, 'A-3');
  reserveUnbooked[0].seats[0].status = 'reserved'; // A-1
  expect((await updatePaid(org, eResvOk._id, { seatingLayout: reserveUnbooked, capacity: 20 })).status).toBe(200);
});

test('AC14 seated capacity cannot be reduced below the number of booked seats', async () => {
  const org = await createOrganiser();
  const manyBooked = grid(['A', 'B'], 5);
  for (let i = 0; i < 5; i++) manyBooked[0].seats[i].status = 'booked'; // A-1..A-5 booked
  const event = await createPaidEvent(org, { capacity: 20, seatingLayout: manyBooked });

  // Keep the layout (booked seats preserved) but drop capacity below the 5 booked -> refused.
  const res = await updatePaid(org, event._id, { seatingLayout: manyBooked, capacity: 3 });
  expect(res.status).toBe(409);
  expect(res.body.message).toMatch(/capacity/i);
});

test('AC19 seating cannot be added to a general-admission event once a ticket has sold', async () => {
  const org = await createOrganiser();
  const buyer = await createUser({ email: 'ga-buyer@test.dev' });
  const event = await createPaidEvent(org, { capacity: 100, ticketTypes: [{ name: 'GA', price: 10 }] }); // non-seated
  await issueTicket(event, org, buyer); // a general-admission sale

  // Trying to introduce a seat layout is refused - the buyers have no seat, so it can't become seated.
  const res = await updatePaid(org, event._id, { seatingLayout: grid(['A', 'B'], 5), capacity: 100 });
  expect(res.status).toBe(409);
  expect(res.body.message).toMatch(/sold/i);
});

// --- Attendee questions (activity) ---

// --- Stop-selling a ticket type (retire without delete) ---

test('AC18 a paid event with every ticket type stopped is rejected on save', async () => {
  const org = await createOrganiser();
  const event = await createPaidEvent(org, { capacity: 100, ticketTypes: [{ name: 'Standard', price: 10 }] });
  const res = await updatePaid(org, event._id, { ticketTypes: [{ name: 'Standard', price: 10, active: false }] });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.body.message).toMatch(/on sale/i);
});

test('AC18 a sold ticket type can be stopped (retired) as long as another stays on sale', async () => {
  const org = await createOrganiser();
  const event = await createPaidEvent(org, {
    capacity: 100, hasActivity: true,
    ticketTypes: [{ name: 'Sold', price: 10, hasSold: true }, { name: 'Open', price: 12 }],
  });
  const res = await updatePaid(org, event._id, {
    ticketTypes: [{ name: 'Sold', price: 10, active: false }, { name: 'Open', price: 12 }],
  });
  expect(res.status).toBe(200);
  const after = await Event.findById(event._id);
  const sold = after.ticketTypes.find((t) => t.name === 'Sold');
  expect(sold.active).toBe(false); // retired
  expect(sold.hasSold).toBe(true); // still marked as having sold (its price/name stay locked)
});

test('AC18 the purchase validator refuses a stopped type but allows an on-sale one', async () => {
  const org = await createOrganiser();
  const event = await createPaidEvent(org, {
    capacity: 100,
    ticketTypes: [{ name: 'Closed', price: 10, active: false }, { name: 'Open', price: 12 }],
  });
  const closed = event.ticketTypes.find((t) => t.name === 'Closed');
  const open = event.ticketTypes.find((t) => t.name === 'Open');

  const blocked = await validateTicketPurchase(event, { [closed._id.toString()]: 1 });
  expect(blocked.isValid).toBe(false);
  expect(blocked.error).toMatch(/no longer available/i);

  const allowed = await validateTicketPurchase(event, { [open._id.toString()]: 1 });
  expect(allowed.isValid).toBe(true);
});

// --- Always editable + notify (D13, D14) ---

test('AC17 changing the venue on an active event is accepted and emails all attendees', async () => {
  const organiser = await createOrganiser();
  const member = await createUser({ email: 'attendee17@test.dev' });
  const event = await createFreeEvent(organiser, { capacity: 100, venue: 'Old Hall' });
  // RSVP creates a FreeTicket and flips hasActivity.
  const rsvp = await request(app)
    .post(`/api/events/${event._id}/free/register`)
    .set('x-api-key', API_KEY).set('Cookie', cookieFor(member))
    .send({ mobile: '0412345678', attendees: [{ name: 'Attendee' }] });
  expect(rsvp.status).toBeLessThan(400);
  clearCapturedEmails();

  // Move the venue (date stays in the future) - accepted, and attendees are notified.
  const res = await updateFree(organiser, event._id, { venue: 'Brand New Hall' });
  expect(res.status).toBe(200);
  const after = await Event.findById(event._id);
  expect(after.venue).toBe('Brand New Hall');

  const notice = await waitForEmail((e) => e.to === 'attendee17@test.dev' && /Event Update/i.test(e.subject));
  expect(notice).toBeTruthy();
});

test('AC11 once there is activity, an existing question cannot be edited or deleted; adding is fine', async () => {
  const organiser = await createOrganiser();
  const seed = () => createFreeEvent(organiser, {
    capacity: 100, hasActivity: true,
    registrationFields: [{ fieldName: 'Diet', fieldType: 'text', isRequired: false }],
  });

  const eEdit = await seed();
  const rEdit = await updateFree(organiser, eEdit._id, {
    registrationFields: [{ fieldName: 'Meal', fieldType: 'text', isRequired: false }], // renamed
  });
  expect(rEdit.status).toBe(409);

  const eDel = await seed();
  const rDel = await updateFree(organiser, eDel._id, { registrationFields: [] }); // deleted
  expect(rDel.status).toBe(409);

  const eAdd = await seed();
  const rAdd = await updateFree(organiser, eAdd._id, {
    registrationFields: [
      { fieldName: 'Diet', fieldType: 'text', isRequired: false }, // unchanged
      { fieldName: 'Shirt size', fieldType: 'text', isRequired: false }, // new
    ],
  });
  expect(rAdd.status).toBe(200);
});
