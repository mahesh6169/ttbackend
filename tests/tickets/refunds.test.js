// Refunds and capacity - see featureplans/fix-events-refund-capacity-release.md. A FULL refund
// cancels the ticket (its place frees up, the door refuses it); a PARTIAL refund keeps the place.
// The real refund engine (applyRefundSuccessData) is driven directly with per-ticket amounts instead
// of the HTTP endpoint, which would need a real Stripe refund against a live charge. Capacity and
// check-in are then asserted through the real APIs.
import PaidTicket from '../../models/paidTicket.js';
import { calculateCurrentTicketsSold } from '../../utils/events/ticketHelpers.js';
import { createOrganiser, createUser, createPaidEvent } from '../helpers/factories.js';
import { api } from '../helpers/eventRequests.js';
import { viewCapacity } from '../helpers/seating.js';
import { paidTicketAt, applyRefund } from '../helpers/money.js';

const scan = (event, organiser, ticket) =>
  api('post', `/api/events/${event._id}/paid/checkin-by-qr`, organiser).send({ ticketNumber: ticket.ticketNumber });

const generalEvent = (organiser) =>
  createPaidEvent(organiser, { capacity: 4, ticketTypes: [{ name: 'General', price: 18 }] });

test('a full refund on a sold-out event frees exactly one place', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const event = await generalEvent(organiser);
  const tickets = [];
  for (let i = 0; i < 4; i++) tickets.push(await paidTicketAt(event, buyer, 18));

  const before = await viewCapacity(event);
  expect(before.body.capacity.sold).toBe(4);
  expect(before.body.capacity.remaining).toBe(0); // sold out

  await applyRefund(tickets[0], 18, organiser); // full

  const after = await viewCapacity(event);
  expect(after.body.capacity.sold).toBe(3);
  expect(after.body.capacity.remaining).toBe(1);
});

test('a partial refund keeps the place taken', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const event = await generalEvent(organiser);
  const ticket = await paidTicketAt(event, buyer, 18);

  const before = await viewCapacity(event);
  expect(before.body.capacity.sold).toBe(1);

  await applyRefund(ticket, 5, organiser); // partial (5 of 18)

  const reloaded = await PaidTicket.findById(ticket._id);
  expect(reloaded.refundStatus).toBe('partial');
  expect(reloaded.checkInStatus).toBe('confirmed'); // still occupies its spot

  const after = await viewCapacity(event);
  expect(after.body.capacity.sold).toBe(1); // unchanged
});

test('a fully refunded ticket is cancelled and refused at the door', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const event = await generalEvent(organiser);
  const ticket = await paidTicketAt(event, buyer, 18);

  await applyRefund(ticket, 18, organiser); // full

  const reloaded = await PaidTicket.findById(ticket._id);
  expect(reloaded.checkInStatus).toBe('cancelled');

  const res = await scan(event, organiser, ticket);
  expect(res.status).toBe(400);
  expect(res.body.errorCode).toBe('TICKET_CANCELLED');
});

test('fully refunding one ticket of a pack frees one place; the rest of the pack stays valid at the door', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const event = await createPaidEvent(organiser, { capacity: 10, ticketTypes: [{ name: 'FamilyFour', price: 18, bundleSize: 4 }] });
  const pack = [];
  for (let i = 0; i < 4; i++) pack.push(await paidTicketAt(event, buyer, 18, { invoiceNumber: 'INV-PACK-0001' }));

  expect(await calculateCurrentTicketsSold(event._id)).toBe(4);

  await applyRefund(pack[0], 18, organiser); // full refund of one member

  expect(await calculateCurrentTicketsSold(event._id)).toBe(3); // exactly one spot freed

  // The other three remain confirmed and are not refused at the door.
  for (const t of pack.slice(1)) {
    const reloaded = await PaidTicket.findById(t._id);
    expect(reloaded.checkInStatus).toBe('confirmed');
  }
  const res = await scan(event, organiser, pack[1]);
  expect(res.body.errorCode).not.toBe('TICKET_CANCELLED');
});
