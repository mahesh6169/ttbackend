// Ticket price and discount floors - see featureplans/events-bundle-pricing.md. A ticket price has at
// most 2 decimals, and no discount code may push any ticket it covers below $1: the wizard save is the
// gate, and create-payment-intent is the silent backstop. The "$1 minimum ticket price" rule itself
// lives in tests/events/create-wizard.test.js; pack-specific floors live in tests/tickets/bundles.test.js.
import Event from '../../models/eventModel.js';
import { createOrganiser, createUser } from '../helpers/factories.js';
import { addPaid, updatePaid, createPaymentIntent } from '../helpers/eventRequests.js';

test('a ticket price is stored to the cent and more than 2 decimals is rejected', async () => {
  const organiser = await createOrganiser();

  const ok = await addPaid(organiser, { ticketTypes: [{ name: 'General', price: 11.99 }] });
  expect(ok.status).toBe(201);
  const event = await Event.findById(ok.body.event._id);
  expect(event.ticketTypes.find((t) => t.name === 'General').price).toBe(11.99);

  const threeDp = await addPaid(organiser, { ticketTypes: [{ name: 'General', price: 11.999 }] });
  expect(threeDp.status).toBe(400);
  expect(threeDp.body.message).toMatch(/2 decimal/i);
});

test('a percent code that would take a $2 ticket below $1 is rejected naming the ticket; one that leaves $1 is accepted', async () => {
  const organiser = await createOrganiser();
  const bad = await addPaid(organiser, {
    ticketTypes: [{ name: 'Cheap', price: 2 }],
    discountCodes: [{ code: 'NINETY', kind: 'percent', value: 90, appliesToTicketTypes: ['Cheap'], active: true }],
  });
  expect(bad.status).toBe(400);
  expect(bad.body.message).toMatch(/Cheap/);
  expect(bad.body.message).toMatch(/\$1/);

  const ok = await addPaid(organiser, {
    ticketTypes: [{ name: 'Cheap', price: 2 }],
    discountCodes: [{ code: 'HALF', kind: 'percent', value: 50, appliesToTicketTypes: ['Cheap'], active: true }],
  });
  expect(ok.status).toBe(201);
});

test('a fixed $5 code is rejected on a $4 ticket but accepted when it only covers a $20 ticket', async () => {
  const organiser = await createOrganiser();
  const types = [{ name: 'Small', price: 4 }, { name: 'Big', price: 20 }];
  const bad = await addPaid(organiser, {
    ticketTypes: types,
    discountCodes: [{ code: 'FIVE', kind: 'fixed', value: 5, appliesToTicketTypes: ['Small'], active: true }],
  });
  expect(bad.status).toBe(400);

  const ok = await addPaid(organiser, {
    ticketTypes: types,
    discountCodes: [{ code: 'FIVE', kind: 'fixed', value: 5, appliesToTicketTypes: ['Big'], active: true }],
  });
  expect(ok.status).toBe(201);
});

test('lowering a ticket price below what a live code allows is rejected on edit', async () => {
  const organiser = await createOrganiser();
  const halfOff = [{ code: 'HALF', kind: 'percent', value: 50, appliesToTicketTypes: ['Std'], active: true }];
  const created = await addPaid(organiser, { ticketTypes: [{ name: 'Std', price: 3 }], discountCodes: halfOff });
  expect(created.status).toBe(201);

  // Editing Std down to $1.50 means 50% leaves $0.75 - the price edit must be rejected.
  const edit = await updatePaid(organiser, created.body.event._id, {
    ticketTypes: [{ name: 'Std', price: 1.5 }],
    discountCodes: halfOff,
  });
  expect(edit.status).toBe(400);
  expect(edit.body.message).toMatch(/Std/);
});

test('payment is refused if a discount would take a ticket below $1, even when the code got past the save check', async () => {
  const organiser = await createOrganiser();
  const member = await createUser();
  const created = await addPaid(organiser, { ticketTypes: [{ name: 'Cheap', price: 2 }] });
  const eventId = created.body.event._id;
  const cheapId = created.body.event.ticketTypes.find((t) => t.name === 'Cheap')._id;

  // Craft a code the save gate would refuse (90% off a $2 ticket) by writing it straight to the DB.
  await Event.updateOne(
    { _id: eventId },
    { $set: { discountCodes: [{ code: 'DEEP', kind: 'percent', value: 90, appliesToTicketTypes: ['Cheap'], active: true, remainingUses: null }] } }
  );

  const pay = await createPaymentIntent(member, eventId, { [cheapId]: 1 }, { discountCode: 'DEEP' });
  expect(pay.status).toBe(400);
  expect(pay.body.message).toMatch(/less than \$1/i);
});
