// Bundle (pack) tickets - see featureplans/events-bundle-pricing.md (which replaced
// events-bundle-ticket.md). The stored price of a bundle type IS the pack price the organiser typed
// (no hidden per-person share, no divides-evenly rule); buyers must buy whole packs. The pack is
// split into N per-ticket cents only at issuance, the N tickets share a pack tag, and every surface
// shows the pack as one line. Full-purchase journeys run in ttfrontend/e2e/bundlepricing.spec.js and
// bundle.spec.js with a real Stripe test card; the money math, the pack tag, the config gates and
// the invoice API are proven here. General price and discount floors live in
// tests/tickets/price-and-discount-rules.test.js.
import mongoose from 'mongoose';
import Event from '../../models/eventModel.js';
import EventInvoice from '../../models/eventInvoice.js';
import {
  planPackIssuance,
  buildInvoiceDisplayLines,
  summarizeSaleLines,
  lineSubtotalCents,
  createEventSnapshot,
} from '../../utils/events/ticketHelpers.js';
import { createOrganiser, createUser } from '../helpers/factories.js';
import { api, addPaid, updatePaid, reserve, createPaymentIntent, viewEvent } from '../helpers/eventRequests.js';
import { sendTicketPurchaseConfirmationToBuyer, sendTicketSaleNotificationToOrganizer } from '../../utils/notifications/events/sendPaidTicketNotifications.js';
import { getCapturedEmails, clearCapturedEmails } from '../helpers/email.js';

const FAMILY_PACK = { name: 'FamilyPack', price: 50, bundleSize: 3 };
const FAMILY_FOUR = { name: 'FamilyFour', price: 72, bundleSize: 4 };

// Create a paid event over the API and return { eventId, typeId(name) }.
const createBundleEvent = async (organiser, overrides) => {
  const res = await addPaid(organiser, overrides);
  expect(res.status).toBe(201);
  const event = res.body.event;
  return { eventId: event._id, typeId: (name) => event.ticketTypes.find((t) => t.name === name)._id };
};

// A deterministic pack-id generator for the pure planner tests.
const seqIds = () => { let n = 0; return () => `pack${n++}`; };
const packEvent = () => ({ ticketTypes: [{ _id: { toString: () => 'ft' }, ...FAMILY_PACK }] });

describe('saving a bundle', () => {
  test('a bundle saves the pack price as typed and its size, and the event snapshot carries both', async () => {
    const organiser = await createOrganiser();
    const res = await addPaid(organiser, { ticketTypes: [FAMILY_PACK] });
    expect(res.status).toBe(201);
    const event = await Event.findById(res.body.event._id);
    const ft = event.ticketTypes.find((t) => t.name === 'FamilyPack');
    expect(ft.price).toBe(50);
    expect(ft.bundleSize).toBe(3);

    // The event snapshot copied into tickets and invoices self-describes the bundle.
    const snapType = createEventSnapshot(event).ticketTypes.find((t) => t.name === 'FamilyPack');
    expect(snapType.bundleSize).toBe(3);
    expect(snapType.price).toBe(50);
  });

  test('a pack price that does not divide evenly by the pack size is accepted and stored as typed', async () => {
    const organiser = await createOrganiser();
    const res = await addPaid(organiser, { ticketTypes: [FAMILY_PACK] }); // $50 / 3
    expect(res.status).toBe(201);
    const event = await Event.findById(res.body.event._id);
    expect(event.ticketTypes.find((t) => t.name === 'FamilyPack').price).toBe(50);
  });

  test('a pack whose per-person share is under $1 is rejected', async () => {
    const organiser = await createOrganiser();
    const res = await addPaid(organiser, { ticketTypes: [{ name: 'FamilyPack', price: 3, bundleSize: 4 }] }); // $0.75 each
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/share must be at least \$1|minimum/i);
  });

  test('a pack bigger than the per-order limit is rejected on create, and when the limit is lowered on edit', async () => {
    const organiser = await createOrganiser();
    const fourPack = [{ name: 'FamilyPack', price: 50, bundleSize: 4 }];
    const bad = await addPaid(organiser, { ticketTypes: fourPack, maxAttendeesPerRegistration: 3 });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/per order|bundle/i);

    const { eventId } = await createBundleEvent(organiser, { ticketTypes: fourPack, maxAttendeesPerRegistration: 10 });
    const edit = await updatePaid(organiser, eventId, { ticketTypes: fourPack, maxAttendeesPerRegistration: 3 });
    expect(edit.status).toBe(400);
    expect(edit.body.message).toMatch(/per order|bundle/i);
  });

  test('a normal ticket type saved alongside a bundle is unaffected', async () => {
    const organiser = await createOrganiser();
    const res = await addPaid(organiser, { ticketTypes: [FAMILY_FOUR, { name: 'General', price: 25 }] });
    expect(res.status).toBe(201);
    const event = await Event.findById(res.body.event._id);
    const general = event.ticketTypes.find((t) => t.name === 'General');
    const family = event.ticketTypes.find((t) => t.name === 'FamilyFour');
    expect(general.price).toBe(25);
    expect(general.bundleSize).toBeUndefined();
    expect(family.price).toBe(72);   // pack price stored as typed
    expect(family.bundleSize).toBe(4);
  });
});

describe('buying whole packs', () => {
  test('a bundle reservation must be a whole number of packs', async () => {
    const organiser = await createOrganiser();
    const member = await createUser();
    const { eventId, typeId } = await createBundleEvent(organiser, { ticketTypes: [FAMILY_FOUR] });
    const ftId = typeId('FamilyFour');

    const ok = await reserve(member, eventId, [{ ticketTypeId: ftId, quantity: 4 }]);
    expect(ok.status).toBe(200);

    const two = await reserve(member, eventId, [{ ticketTypeId: ftId, quantity: 2 }]);
    expect(two.status).toBe(400);
    expect(two.body.message).toMatch(/pack|multiple/i);

    const six = await reserve(member, eventId, [{ ticketTypeId: ftId, quantity: 6 }]);
    expect(six.status).toBe(400);
  });

  test('a reservation made before the pack size changed is refused when payment is priced', async () => {
    const organiser = await createOrganiser();
    const member = await createUser();
    const { eventId, typeId } = await createBundleEvent(organiser, { ticketTypes: [FAMILY_FOUR] });
    const ftId = typeId('FamilyFour');

    // Buyer holds a valid pack of 4 under the original size.
    const held = await reserve(member, eventId, [{ ticketTypeId: ftId, quantity: 4 }]);
    expect(held.status).toBe(200);

    // Organiser edits the bundle size to 5 - the held 4 is now an invalid multiple.
    await Event.updateOne({ _id: eventId }, { $set: { 'ticketTypes.0.bundleSize': 5 } });

    const pay = await createPaymentIntent(member, eventId, { [ftId]: 4 });
    expect(pay.status).toBe(400);
    expect(pay.body.message).toMatch(/pack|multiple/i);
  });

  test('two bundle types in one cart are each checked for whole packs, and the total is right', async () => {
    const organiser = await createOrganiser();
    const member = await createUser();
    const { eventId, typeId } = await createBundleEvent(organiser, {
      ticketTypes: [FAMILY_FOUR, { name: 'CoupleTwo', price: 40, bundleSize: 2 }],
    });
    const ffId = typeId('FamilyFour');
    const ctId = typeId('CoupleTwo');

    const both = await reserve(member, eventId, [
      { ticketTypeId: ffId, quantity: 4 },
      { ticketTypeId: ctId, quantity: 2 },
    ]);
    expect(both.status).toBe(200);
    expect(both.body.totalAmount).toBe(112); // one $72 pack + one $40 pack

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

  test('a pack that does not fit the places left is refused', async () => {
    const organiser = await createOrganiser();
    const member = await createUser();
    const { eventId, typeId } = await createBundleEvent(organiser, {
      ticketTypes: [FAMILY_FOUR],
      capacity: 3, // only 3 spots - a pack of 4 cannot fit
    });

    const res = await reserve(member, eventId, [{ ticketTypeId: typeId('FamilyFour'), quantity: 4 }]);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/available|remaining|reduce/i);
  });
});

describe('pack money', () => {
  test('one $50 pack reserves at $50 and two packs are priced at $100', async () => {
    const organiser = await createOrganiser();
    const member = await createUser();
    const { eventId, typeId } = await createBundleEvent(organiser, { ticketTypes: [FAMILY_PACK] });
    const ftId = typeId('FamilyPack');

    const one = await reserve(member, eventId, [{ ticketTypeId: ftId, quantity: 3 }]);
    expect(one.status).toBe(200);
    expect(one.body.totalAmount).toBe(50);

    const pay = await createPaymentIntent(member, eventId, { [ftId]: 6 });
    expect(pay.status).toBe(200);
    expect(pay.body.pricing.total).toBe(100);
  });

  test('a 10% code on a $72 pack takes $7.20 off at payment', async () => {
    const organiser = await createOrganiser();
    const member = await createUser();
    const { eventId, typeId } = await createBundleEvent(organiser, {
      ticketTypes: [FAMILY_FOUR],
      discountCodes: [
        { code: 'FAM10', kind: 'percent', value: 10, appliesToTicketTypes: ['FamilyFour'], active: true, showHint: false },
      ],
    });

    const pay = await createPaymentIntent(member, eventId, { [typeId('FamilyFour')]: 4 }, { discountCode: 'FAM10' });
    expect(pay.status).toBe(200);
    expect(pay.body.pricing.discountAmount).toBe(7.2); // 10% of the $72 pack
  });

  test('a code that would leave a pack\'s per-person share under $1 is rejected at save', async () => {
    const organiser = await createOrganiser();
    const res = await addPaid(organiser, {
      ticketTypes: [{ name: 'MiniPack', price: 6, bundleSize: 3 }], // $2 per head
      discountCodes: [{ code: 'NINETY', kind: 'percent', value: 90, appliesToTicketTypes: ['MiniPack'], active: true }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/MiniPack/);
  });

  test('a $50 pack of 3 issues 3 tickets of $16.67/$16.67/$16.66 that add up to exactly $50 and share one pack tag', () => {
    const plan = planPackIssuance(packEvent(), { ft: 3 }, 0, null, seqIds());
    expect(plan).toHaveLength(3);
    const cents = plan.map((p) => p.netPriceCents).sort((a, b) => b - a);
    expect(cents).toEqual([1667, 1667, 1666]);
    expect(cents.reduce((s, c) => s + c, 0)).toBe(5000); // each ticket refundable up to its own price
    expect(new Set(plan.map((p) => p.packId)).size).toBe(1);

    // The invoice lines collapse those 3 rows into ONE pack line at $50 (admits 3) - no $50.01.
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

  test('a $5 discount on the $50 pack leaves its 3 tickets adding up to exactly $45', () => {
    const plan = planPackIssuance(packEvent(), { ft: 3 }, 500, new Set(['FamilyPack']), seqIds());
    const net = plan.map((p) => p.netPriceCents);
    expect(net.reduce((s, c) => s + c, 0)).toBe(4500);
  });

  test('the order subtotal counts a pack as one $50 line, not 3 x $16.67', () => {
    expect(lineSubtotalCents(packEvent().ticketTypes[0], 3)).toBe(5000);
  });
});

describe('after the sale', () => {
  test('the invoice shows the pack as one $50 line that admits 3', async () => {
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

    const res = await api('get', '/api/events/invoices/INV-PACK-0001', member);
    expect(res.status).toBe(200);
    const lines = res.body.invoice.displayLineItems;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ isPack: true, admits: 3, price: 50, amount: 50 });
    expect(lines.every((l) => l.amount !== 50.01)).toBe(true);
  });

  test('the organiser\'s sales list shows the pack as one $50 line', () => {
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

  test('the buyer\'s confirmation email shows the pack as one $50 line', async () => {
    clearCapturedEmails();
    const { event, tickets, invoice } = packEmailFixture();
    await sendTicketPurchaseConfirmationToBuyer({ invoice, tickets, event });
    const mail = getCapturedEmails().find((m) => m.to === 'buyer@test.dev');
    expect(mail).toBeTruthy();
    expect(mail.html).toContain('FamilyPack (admits 3)');
    expect(mail.html).toContain('$50.00');
    expect(mail.html).not.toContain('16.67');
  });

  test('the organiser\'s sale email shows the pack as one $50 line', async () => {
    clearCapturedEmails();
    const { event, tickets, invoice } = packEmailFixture();
    await sendTicketSaleNotificationToOrganizer({ invoice, tickets, event, organizerEmail: 'org@test.dev' });
    const mail = getCapturedEmails().find((m) => m.to === 'org@test.dev');
    expect(mail).toBeTruthy();
    expect(mail.html).toContain('FamilyPack (admits 3)');
    expect(mail.html).toContain('$50.00');
    expect(mail.html).not.toContain('16.67');
  });

  test('the event page data gives the bundle at its $50 pack price with its size', async () => {
    const organiser = await createOrganiser();
    const { eventId } = await createBundleEvent(organiser, { ticketTypes: [FAMILY_PACK] });

    const res = await viewEvent(eventId);
    expect(res.status).toBe(200);
    const event = res.body.event || res.body;
    const ft = (event.ticketTypes || []).find((t) => t.name === 'FamilyPack');
    expect(ft.price).toBe(50);        // the pack price directly - the page shows "$50 (admits 3)"
    expect(ft.bundleSize).toBe(3);
  });
});
