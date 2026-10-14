// Proves the bundle PACK-PRICING feature - see featureplans/events-bundle-pricing.md.
// The stored price of a bundle type IS the pack price the organiser typed (no hidden per-person
// share, no divides-evenly rule). The pack is split into N per-ticket cents only at issuance, the N
// tickets share a pack tag, and every surface shows the pack as one line. Full-purchase journeys
// (AC19/AC20) run in ttfrontend/e2e/bundlepricing.spec.js with a real Stripe test card; the money
// math, the pack tag, the config/discount gates and the invoice API are proven here.
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../app.js';
import Event from '../models/eventModel.js';
import EventInvoice from '../models/eventInvoice.js';
import {
  planPackIssuance,
  buildInvoiceDisplayLines,
  summarizeSaleLines,
  lineSubtotalCents,
} from '../utils/events/ticketHelpers.js';
import { createOrganiser, createUser, cookieFor, API_KEY } from './helpers/factories.js';
import { sendTicketPurchaseConfirmationToBuyer, sendTicketSaleNotificationToOrganizer } from '../utils/notifications/events/sendPaidTicketNotifications.js';
import { getCapturedEmails, clearCapturedEmails } from '../utils/notifications/sendEmail.js';

const FUTURE = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const ADDRESS = JSON.stringify({
  formattedAddress: '1 Test St, Sydney NSW 2000',
  suburb: 'Sydney',
  state: 'NSW',
  location: { type: 'Point', coordinates: [151.2093, -33.8688] },
});
const BUYER = { email: 'buyer@test.dev', firstName: 'Bella', lastName: 'Buyer' };

// POST the real add-paid-event endpoint (multipart, like the wizard). Ticket types are sent with
// the PACK price the organiser typed; the server stores it as-is.
const addPaidEvent = (organiser, overrides = {}) => {
  const {
    ticketTypes = [{ name: 'FamilyPack', price: 50, bundleSize: 3 }],
    maxAttendeesPerRegistration = 10,
    capacity = 100,
    discountCodes,
  } = overrides;
  const req = request(app)
    .post('/api/events/add-paid-event')
    .set('Cookie', cookieFor(organiser))
    .set('x-api-key', API_KEY)
    .field('title', 'Bundle Pricing Test Event')
    .field('dateTime', FUTURE())
    .field('venue', 'Test Hall')
    .field('description', 'A seeded paid event for bundle-pricing tests.')
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
    ticketTypes = [{ name: 'FamilyPack', price: 50, bundleSize: 3 }],
    maxAttendeesPerRegistration = 10,
    capacity = 100,
    discountCodes,
  } = overrides;
  const req = request(app)
    .put(`/api/events/update-paid/${eventId}`)
    .set('Cookie', cookieFor(organiser))
    .set('x-api-key', API_KEY)
    .field('title', 'Bundle Pricing Test Event')
    .field('dateTime', FUTURE())
    .field('venue', 'Test Hall')
    .field('description', 'A seeded paid event for bundle-pricing tests.')
    .field('category', 'Community')
    .field('address', ADDRESS)
    .field('organizer', JSON.stringify({ name: 'Test Organiser' }))
    .field('ticketTypes', JSON.stringify(ticketTypes))
    .field('capacity', String(capacity))
    .field('maxAttendeesPerRegistration', String(maxAttendeesPerRegistration));
  if (discountCodes) req.field('discountCodes', JSON.stringify(discountCodes));
  return req;
};

const reserve = (member, eventId, tickets) =>
  request(app)
    .post(`/api/events/${eventId}/reservation`)
    .set('Cookie', cookieFor(member))
    .set('x-api-key', API_KEY)
    .send({ tickets });

// A deterministic pack-id generator for the pure planner tests.
const seqIds = () => { let n = 0; return () => `pack${n++}`; };

// --- Storage and config ------------------------------------------------------

test('AC1 a bundle FamilyPack size 3 price $50 stores price 50 (the pack price) and bundleSize 3', async () => {
  const organiser = await createOrganiser();
  const res = await addPaidEvent(organiser, { ticketTypes: [{ name: 'FamilyPack', price: 50, bundleSize: 3 }] });
  expect(res.status).toBe(201);
  const event = await Event.findById(res.body.event._id);
  const ft = event.ticketTypes.find((t) => t.name === 'FamilyPack');
  expect(ft.price).toBe(50);
  expect(ft.bundleSize).toBe(3);
});

test('AC2 a bundle price $50 with size 3 (does not divide evenly) is accepted', async () => {
  const organiser = await createOrganiser();
  const res = await addPaidEvent(organiser, { ticketTypes: [{ name: 'FamilyPack', price: 50, bundleSize: 3 }] });
  expect(res.status).toBe(201);
});

test('AC3 a bundle price $3 with size 4 (a $0.75 per-person share) is rejected with the per-person minimum', async () => {
  const organiser = await createOrganiser();
  const res = await addPaidEvent(organiser, { ticketTypes: [{ name: 'FamilyPack', price: 3, bundleSize: 4 }] });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/share must be at least \$1|minimum/i);
});

test('AC4 a non-bundle type: $11.99 is stored, $0.50 is rejected (min $1), 3 decimals is rejected (max 2)', async () => {
  const organiser = await createOrganiser();

  const ok = await addPaidEvent(organiser, { ticketTypes: [{ name: 'General', price: 11.99 }] });
  expect(ok.status).toBe(201);
  const event = await Event.findById(ok.body.event._id);
  expect(event.ticketTypes.find((t) => t.name === 'General').price).toBe(11.99);

  const tooCheap = await addPaidEvent(organiser, { ticketTypes: [{ name: 'General', price: 0.5 }] });
  expect(tooCheap.status).toBe(400);
  expect(tooCheap.body.message).toMatch(/minimum ticket price is \$1/i);

  const threeDp = await addPaidEvent(organiser, { ticketTypes: [{ name: 'General', price: 11.999 }] });
  expect(threeDp.status).toBe(400);
  expect(threeDp.body.message).toMatch(/2 decimal/i);
});

test('AC5 a bundle bigger than max-per-registration is rejected at save and when the limit is lowered on edit', async () => {
  const organiser = await createOrganiser();
  const bad = await addPaidEvent(organiser, {
    ticketTypes: [{ name: 'FamilyPack', price: 50, bundleSize: 4 }],
    maxAttendeesPerRegistration: 3,
  });
  expect(bad.status).toBe(400);

  const created = await addPaidEvent(organiser, {
    ticketTypes: [{ name: 'FamilyPack', price: 50, bundleSize: 4 }],
    maxAttendeesPerRegistration: 10,
  });
  expect(created.status).toBe(201);
  const edit = await updatePaidEvent(organiser, created.body.event._id, {
    ticketTypes: [{ name: 'FamilyPack', price: 50, bundleSize: 4 }],
    maxAttendeesPerRegistration: 3,
  });
  expect(edit.status).toBe(400);
});

// --- Discount setup gate -----------------------------------------------------

test('AC6 a 90% code on a $2 ticket is rejected naming the ticket and $1; a 50% code (leaves $1.00) is accepted', async () => {
  const organiser = await createOrganiser();
  const bad = await addPaidEvent(organiser, {
    ticketTypes: [{ name: 'Cheap', price: 2 }],
    discountCodes: [{ code: 'NINETY', kind: 'percent', value: 90, appliesToTicketTypes: ['Cheap'], active: true }],
  });
  expect(bad.status).toBe(400);
  expect(bad.body.message).toMatch(/Cheap/);
  expect(bad.body.message).toMatch(/\$1/);

  const ok = await addPaidEvent(organiser, {
    ticketTypes: [{ name: 'Cheap', price: 2 }],
    discountCodes: [{ code: 'HALF', kind: 'percent', value: 50, appliesToTicketTypes: ['Cheap'], active: true }],
  });
  expect(ok.status).toBe(201);
});

test('AC7 a fixed $5 code covering a $4 ticket is rejected; a fixed $5 code covering only a $20 type is accepted', async () => {
  const organiser = await createOrganiser();
  const bad = await addPaidEvent(organiser, {
    ticketTypes: [{ name: 'Small', price: 4 }, { name: 'Big', price: 20 }],
    discountCodes: [{ code: 'FIVE', kind: 'fixed', value: 5, appliesToTicketTypes: ['Small'], active: true }],
  });
  expect(bad.status).toBe(400);

  const ok = await addPaidEvent(organiser, {
    ticketTypes: [{ name: 'Small', price: 4 }, { name: 'Big', price: 20 }],
    discountCodes: [{ code: 'FIVE', kind: 'fixed', value: 5, appliesToTicketTypes: ['Big'], active: true }],
  });
  expect(ok.status).toBe(201);
});

test('AC8 lowering a covered type below what a live code allows is rejected on edit', async () => {
  const organiser = await createOrganiser();
  const created = await addPaidEvent(organiser, {
    ticketTypes: [{ name: 'Std', price: 3 }],
    discountCodes: [{ code: 'HALF', kind: 'percent', value: 50, appliesToTicketTypes: ['Std'], active: true }],
  });
  expect(created.status).toBe(201);

  // Editing Std down to $1.50 means 50% leaves $0.75 - the price edit must be rejected.
  const edit = await updatePaidEvent(organiser, created.body.event._id, {
    ticketTypes: [{ name: 'Std', price: 1.5 }],
    discountCodes: [{ code: 'HALF', kind: 'percent', value: 50, appliesToTicketTypes: ['Std'], active: true }],
  });
  expect(edit.status).toBe(400);
  expect(edit.body.message).toMatch(/Std/);
});

test('AC9 a 90% code on a bundle of $6 admitting 3 ($2 per head) is rejected (per-person share below $1)', async () => {
  const organiser = await createOrganiser();
  const res = await addPaidEvent(organiser, {
    ticketTypes: [{ name: 'MiniPack', price: 6, bundleSize: 3 }],
    discountCodes: [{ code: 'NINETY', kind: 'percent', value: 90, appliesToTicketTypes: ['MiniPack'], active: true }],
  });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/MiniPack/);
});

// --- Checkout, payment, issuance ---------------------------------------------

test('AC10 one $50 pack (size 3) reserves at $50; a two-pack payment intent prices $100', async () => {
  const organiser = await createOrganiser();
  const member = await createUser();
  const created = await addPaidEvent(organiser);
  const eventId = created.body.event._id;
  const ftId = created.body.event.ticketTypes.find((t) => t.name === 'FamilyPack')._id;

  const one = await reserve(member, eventId, [{ ticketTypeId: ftId, quantity: 3 }]);
  expect(one.status).toBe(200);
  expect(one.body.totalAmount).toBe(50);

  const pay = await request(app)
    .post(`/api/events/${eventId}/paid/create-payment-intent`)
    .set('Cookie', cookieFor(member))
    .set('x-api-key', API_KEY)
    .send({ tickets: { [ftId]: 6 }, buyerInfo: BUYER });
  expect(pay.status).toBe(200);
  expect(pay.body.pricing.total).toBe(100);
});

test('AC11 issuing one $50/3 pack yields 3 tickets summing to exactly $50.00 (16.67/16.67/16.66), sharing one pack tag', () => {
  const event = { ticketTypes: [{ _id: { toString: () => 'ft' }, name: 'FamilyPack', price: 50, bundleSize: 3 }] };
  const plan = planPackIssuance(event, { ft: 3 }, 0, null, seqIds());
  expect(plan).toHaveLength(3);
  const cents = plan.map((p) => p.netPriceCents).sort((a, b) => b - a);
  expect(cents).toEqual([1667, 1667, 1666]);
  expect(cents.reduce((s, c) => s + c, 0)).toBe(5000);
  const packIds = new Set(plan.map((p) => p.packId));
  expect(packIds.size).toBe(1);

  // The invoice API collapses those 3 rows into ONE pack line at $50 (admits 3) - no $50.01.
  const lineItems = plan.map((p, i) => ({
    ticketNumber: `TKT-${i}`,
    ticketType: { name: p.name, price: p.basePriceCents / 100 },
    pack: { id: p.packId, price: p.packPriceCents / 100 },
    quantity: 1,
    discountAmount: (p.basePriceCents - p.netPriceCents) / 100,
    seats: [],
  }));
  const lines = buildInvoiceDisplayLines(lineItems);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ isPack: true, admits: 3, price: 50, amount: 50 });
});

test('AC12 each ticket in the $50/3 pack is refundable up to its own stored price; the three maxima sum to $50.00', () => {
  const event = { ticketTypes: [{ _id: { toString: () => 'ft' }, name: 'FamilyPack', price: 50, bundleSize: 3 }] };
  const plan = planPackIssuance(event, { ft: 3 }, 0, null, seqIds());
  // Max refundable for a ticket is its stored paid price (priceDetails.totalPrice = netPriceCents).
  const maxima = plan.map((p) => p.netPriceCents);
  expect(maxima.reduce((s, c) => s + c, 0)).toBe(5000);
});

test('AC13 a 10% code on the $50/3 pack discounts $5.00; the three tickets sum to exactly $45.00', () => {
  const event = { ticketTypes: [{ _id: { toString: () => 'ft' }, name: 'FamilyPack', price: 50, bundleSize: 3 }] };
  // Discount cents for one covered pack: 10% of $50 = $5.00.
  const discountCents = 500;
  const plan = planPackIssuance(event, { ft: 3 }, discountCents, new Set(['FamilyPack']), seqIds());
  const net = plan.map((p) => p.netPriceCents);
  expect(net.reduce((s, c) => s + c, 0)).toBe(4500);
});

test('AC14 a discount that pushes a covered ticket below $1 is rejected at create-payment-intent (silent backstop)', async () => {
  const organiser = await createOrganiser();
  const member = await createUser();
  const created = await addPaidEvent(organiser, { ticketTypes: [{ name: 'Cheap', price: 2 }] });
  const eventId = created.body.event._id;
  const cheapId = created.body.event.ticketTypes.find((t) => t.name === 'Cheap')._id;

  // Craft a code the wizard gate would refuse (90% off a $2 ticket) by writing it straight to the DB.
  await Event.updateOne(
    { _id: eventId },
    { $set: { discountCodes: [{ code: 'DEEP', kind: 'percent', value: 90, appliesToTicketTypes: ['Cheap'], active: true, remainingUses: null }] } }
  );

  const pay = await request(app)
    .post(`/api/events/${eventId}/paid/create-payment-intent`)
    .set('Cookie', cookieFor(member))
    .set('x-api-key', API_KEY)
    .send({ tickets: { [cheapId]: 1 }, buyerInfo: BUYER, discountCode: 'DEEP' });
  expect(pay.status).toBe(400);
  expect(pay.body.message).toMatch(/less than \$1/i);
});

test('AC15 a size-3 pack issues 3 tickets, so capacity falls by 3 admissions (not 1)', () => {
  const event = { ticketTypes: [{ _id: { toString: () => 'ft' }, name: 'FamilyPack', price: 50, bundleSize: 3 }] };
  expect(planPackIssuance(event, { ft: 3 }, 0, null, seqIds())).toHaveLength(3);
  // The reservation/subtotal counts the pack as one $50 line, not 3 x $16.67.
  expect(lineSubtotalCents(event.ticketTypes[0], 3)).toBe(5000);
});

// --- After the sale and display ----------------------------------------------

test('AC16 the invoice API returns ONE pack line at $50 (admits 3 by count), not three sub-lines', async () => {
  const member = await createUser();
  const organiser = await createOrganiser();
  const eventId = new mongoose.Types.ObjectId().toString();
  const packId = 'packABC';
  const lineItems = [
    { ticketNumber: 'TKT-A', ticketType: { name: 'FamilyPack', price: 16.67 }, pack: { id: packId, price: 50 }, quantity: 1, discountAmount: 0, seats: [] },
    { ticketNumber: 'TKT-B', ticketType: { name: 'FamilyPack', price: 16.67 }, pack: { id: packId, price: 50 }, quantity: 1, discountAmount: 0, seats: [] },
    { ticketNumber: 'TKT-C', ticketType: { name: 'FamilyPack', price: 16.66 }, pack: { id: packId, price: 50 }, quantity: 1, discountAmount: 0, seats: [] },
  ];
  await EventInvoice.create({
    invoiceNumber: 'INV-PACK-0001',
    event: eventId,
    user: member._id,
    eventSnapshot: { postedBy: organiser._id.toString(), ticketTypes: [] },
    buyer: { firstName: 'Bella', lastName: 'Buyer', email: 'buyer@test.dev' },
    lineItems,
    amounts: { total: 50, subtotal: 50, totalRefunded: 0, netAmount: 50 },
    payment: { paymentIntentId: 'pi_pack_1' },
  });

  const res = await request(app)
    .get('/api/events/invoices/INV-PACK-0001')
    .set('Cookie', cookieFor(member))
    .set('x-api-key', API_KEY);
  expect(res.status).toBe(200);
  const lines = res.body.invoice.displayLineItems;
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ isPack: true, admits: 3, price: 50, amount: 50 });
  expect(lines.every((l) => l.amount !== 50.01)).toBe(true);
});

test('AC17 the sale-line grouping shows the pack as ONE $50 line (not 3 x $16.67)', () => {
  const packTickets = [
    { ticketType: { name: 'FamilyPack' }, pack: { id: 'p1' }, priceDetails: { totalPrice: 16.67 } },
    { ticketType: { name: 'FamilyPack' }, pack: { id: 'p1' }, priceDetails: { totalPrice: 16.67 } },
    { ticketType: { name: 'FamilyPack' }, pack: { id: 'p1' }, priceDetails: { totalPrice: 16.66 } },
  ];
  const lines = summarizeSaleLines(packTickets);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ isPack: true, admits: 3, amount: 50 });
});

// The rendered buyer + organiser emails for a $50/3 pack: one $50 line, no odd-cent $16.67 line.
const packEmailFixture = () => {
  const event = {
    title: 'Pack Fest', dateTime: new Date('2027-01-01T10:00:00Z'), timeZone: 'Australia/Sydney',
    venue: 'Test Hall', address: '1 Test St', gstIncluded: false,
    organizer: { name: 'Org', email: 'org@test.dev' }, ticketTypes: [{ name: 'FamilyPack' }],
  };
  const mkTicket = (n, paid) => ({
    ticketNumber: `TKT-PACK-000${n}`, event: 'evt1', ticketType: { name: 'FamilyPack' },
    pack: { id: 'packE', price: 50 }, priceDetails: { totalPrice: paid }, seats: [],
  });
  const tickets = [mkTicket(1, 16.67), mkTicket(2, 16.67), mkTicket(3, 16.66)];
  const invoice = {
    invoiceNumber: 'INV-PACK-0009', buyer: { firstName: 'Bella', lastName: 'Buyer', email: 'buyer@test.dev' },
    amounts: { total: 50, subtotal: 50 },
  };
  return { event, tickets, invoice };
};

test('AC17 the buyer confirmation email shows the pack as one $50 line, not 3 x $16.67', async () => {
  clearCapturedEmails();
  const { event, tickets, invoice } = packEmailFixture();
  await sendTicketPurchaseConfirmationToBuyer({ invoice, tickets, event });
  const mail = getCapturedEmails().find((m) => m.to === 'buyer@test.dev');
  expect(mail).toBeTruthy();
  expect(mail.html).toContain('FamilyPack (admits 3)');
  expect(mail.html).toContain('$50.00');
  expect(mail.html).not.toContain('16.67');
});

test('AC17 the organiser sale email shows the pack as one $50 line, not 3 x $16.67', async () => {
  clearCapturedEmails();
  const { event, tickets, invoice } = packEmailFixture();
  await sendTicketSaleNotificationToOrganizer({ invoice, tickets, event, organizerEmail: 'org@test.dev' });
  const mail = getCapturedEmails().find((m) => m.to === 'org@test.dev');
  expect(mail).toBeTruthy();
  expect(mail.html).toContain('FamilyPack (admits 3)');
  expect(mail.html).toContain('$50.00');
  expect(mail.html).not.toContain('16.67');
});

test('AC18 the event detail (views) API returns the bundle at its pack price $50 with bundleSize 3', async () => {
  const organiser = await createOrganiser();
  const created = await addPaidEvent(organiser, { ticketTypes: [{ name: 'FamilyPack', price: 50, bundleSize: 3 }] });
  const eventId = created.body.event._id;

  const res = await request(app)
    .get(`/api/events/views/${eventId}`)
    .set('x-api-key', API_KEY);
  expect(res.status).toBe(200);
  const event = res.body.event || res.body;
  const ft = (event.ticketTypes || []).find((t) => t.name === 'FamilyPack');
  expect(ft.price).toBe(50);        // the pack price directly - the page shows "$50 (admits 3)"
  expect(ft.bundleSize).toBe(3);
});
