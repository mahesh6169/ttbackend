// Activity-based edit locking - see featureplans/events-edit-locking.md.
// The server flips hasActivity / a ticket type's hasSold the moment activity happens, the owner
// edit-load returns those signals plus a committed count, and the update endpoints refuse edits that
// would change what buyers already paid for or answered, while leaving everything else editable.
// The seat-layout side of locking lives in tests/seating/layout-lock.test.js; question locking lives
// in tests/rsvp/question-types.test.js and tests/rsvp/question-editing.test.js.
// NOTE: the PAID first-sale flag-set lives inside confirmPayment (real Stripe), which the backend
// suite never drives - that assertion is proven in the e2e spec (ttfrontend editlocking.spec.js)
// against a real purchase.
import Event from '../../models/eventModel.js';
import {
  createOrganiser, createUser, createFreeEvent, createPaidEvent, createPaidTicket,
} from '../helpers/factories.js';
import { updatePaid, updateFree, registerFree, viewEvent, FUTURE } from '../helpers/eventRequests.js';
import { grid } from '../helpers/seating.js';
import { clearCapturedEmails, waitForEmail } from '../helpers/email.js';
import { validateTicketPurchase } from '../../utils/events/ticketHelpers.js';

describe('activity signals', () => {
  test('the first free RSVP marks the event as having activity', async () => {
    const organiser = await createOrganiser();
    const member = await createUser({ email: 'el-rsvp@test.dev' });
    const event = await createFreeEvent(organiser, { capacity: 100 });

    expect(event.hasActivity).toBe(false); // clean event

    const res = await registerFree(event, member, { attendees: [{ name: 'Racer' }] });
    expect(res.status).toBeLessThan(400);

    const after = await Event.findById(event._id);
    expect(after.hasActivity).toBe(true);
  });

  test('the owner edit-load returns the activity signals, the committed count and per-seat status', async () => {
    const organiser = await createOrganiser();
    const buyer = await createUser({ email: 'el-buyer@test.dev' });
    const event = await createPaidEvent(organiser, {
      capacity: 100,
      hasActivity: true,
      hasSeating: true,
      ticketTypes: [{ name: 'Standard', price: 10, hasSold: true }],
      seatingLayout: grid(['A'], 5, 'A-1'), // A-1 booked
    });
    await createPaidTicket(event, buyer); // committed count = 1

    const res = await viewEvent(event._id, organiser); // owner load
    expect(res.status).toBe(200);

    expect(res.body.hasActivity).toBe(true);
    expect(res.body.hasSeating).toBe(true);
    expect(res.body.ticketTypes[0].hasSold).toBe(true);
    expect(res.body.committedCount).toBe(1);
    // per-seat status rides along on the layout
    const a1 = res.body.seatingLayout[0].seats.find((s) => s.seatId === 'A-1');
    expect(a1.status).toBe('booked');
  });
});

describe('always locked, and nothing locked before activity', () => {
  test('changing the event type (free to paid) is refused', async () => {
    const organiser = await createOrganiser();
    const event = await createFreeEvent(organiser, { capacity: 100 }); // a FREE event
    // Push it through the PAID update endpoint - a genuine free -> paid type change.
    const res = await updatePaid(organiser, event._id, { ticketTypes: [{ name: 'Standard', price: 10 }] });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/event type/i);
  });

  test('an event with no activity is fully editable', async () => {
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
});

describe('ticket types', () => {
  test('a sold ticket type cannot be repriced, renamed, made a bundle or deleted', async () => {
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

  test('an unsold ticket type can be edited or deleted, and new types can always be added', async () => {
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

  test('saving a paid event with every ticket type stopped is refused', async () => {
    const org = await createOrganiser();
    const event = await createPaidEvent(org, { capacity: 100, ticketTypes: [{ name: 'Standard', price: 10 }] });
    const res = await updatePaid(org, event._id, { ticketTypes: [{ name: 'Standard', price: 10, active: false }] });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.message).toMatch(/on sale/i);
  });

  test('a sold ticket type can be stopped while another stays on sale, and stays marked as sold', async () => {
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

  test('a stopped ticket type cannot be bought; an on-sale one can', async () => {
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
});

describe('discount codes', () => {
  test('a used discount code cannot be changed or deleted; an unused one can be rewritten', async () => {
    const organiser = await createOrganiser();
    const usedSeed = () => createPaidEvent(organiser, {
      capacity: 100, hasActivity: true,
      ticketTypes: [{ name: 'Standard', price: 10 }, { name: 'VIP', price: 20 }],
      discountCodes: [{ code: 'SAVE10', kind: 'percent', value: 10, usedCount: 1, active: true, appliesToTicketTypes: ['Standard'] }],
    });
    const bothTypes = [{ name: 'Standard', price: 10 }, { name: 'VIP', price: 20 }];

    const e1 = await usedSeed();
    const rVal = await updatePaid(organiser, e1._id, {
      ticketTypes: bothTypes,
      discountCodes: [{ code: 'SAVE10', kind: 'percent', value: 25, active: true, appliesToTicketTypes: ['Standard'] }],
    });
    expect(rVal.status).toBe(409);

    const e2 = await usedSeed();
    const rApplies = await updatePaid(organiser, e2._id, {
      ticketTypes: bothTypes,
      discountCodes: [{ code: 'SAVE10', kind: 'percent', value: 10, active: true, appliesToTicketTypes: ['VIP'] }],
    });
    expect(rApplies.status).toBe(409);

    const e3 = await usedSeed();
    const rDelete = await updatePaid(organiser, e3._id, {
      ticketTypes: bothTypes,
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

  test('a used code\'s max uses can be raised but not set below the uses so far; its window and on/off stay editable', async () => {
    const organiser = await createOrganiser();
    const seed = () => createPaidEvent(organiser, {
      capacity: 100, hasActivity: true,
      ticketTypes: [{ name: 'Standard', price: 10 }],
      discountCodes: [{ code: 'SAVE10', kind: 'percent', value: 10, usedCount: 2, maxUses: 5, remainingUses: 3, active: true, appliesToTicketTypes: ['Standard'] }],
    });

    const eLow = await seed();
    const rLow = await updatePaid(organiser, eLow._id, {
      discountCodes: [{ code: 'SAVE10', kind: 'percent', value: 10, maxUses: 1, active: true, appliesToTicketTypes: ['Standard'] }],
    });
    expect(rLow.status).toBeGreaterThanOrEqual(400); // 2 already used, floor is 2

    const eOk = await seed();
    const rOk = await updatePaid(organiser, eOk._id, {
      discountCodes: [{ code: 'SAVE10', kind: 'percent', value: 10, maxUses: 10, active: false, validUntil: FUTURE(), appliesToTicketTypes: ['Standard'] }],
    });
    expect(rOk.status).toBe(200);
    const after = await Event.findById(eOk._id);
    const code = after.discountCodes.find((c) => c.code === 'SAVE10');
    expect(code.maxUses).toBe(10);
    expect(code.active).toBe(false); // deactivate stayed editable
  });
});

describe('capacity and always-editable details', () => {
  test('capacity cannot drop below the tickets already sold; raising it is fine', async () => {
    const organiser = await createOrganiser();
    const buyer = await createUser({ email: 'el-cap@test.dev' });
    const event = await createPaidEvent(organiser, {
      capacity: 100, hasActivity: true, ticketTypes: [{ name: 'Standard', price: 10 }],
    });
    for (let i = 0; i < 5; i++) await createPaidTicket(event, buyer); // committed = 5

    const rLow = await updatePaid(organiser, event._id, { capacity: 3 });
    expect(rLow.status).toBe(409);
    expect(rLow.body.message).toMatch(/capacity/i);

    const rUp = await updatePaid(organiser, event._id, { capacity: 200 });
    expect(rUp.status).toBe(200);
    const after = await Event.findById(event._id);
    expect(after.capacity).toBe(200);
  });

  test('changing the venue of an event with attendees is accepted and emails every attendee', async () => {
    const organiser = await createOrganiser();
    const member = await createUser({ email: 'attendee17@test.dev' });
    const event = await createFreeEvent(organiser, { capacity: 100, venue: 'Old Hall' });
    // RSVP creates a FreeTicket and flips hasActivity.
    const rsvp = await registerFree(event, member);
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
});
