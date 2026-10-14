// Proves capacity releases correctly on refunds — see featureplans/fix-events-refund-capacity-release.md.
// A FULL refund cancels the ticket (spot frees, door refuses it); a PARTIAL refund keeps the spot.
// Note: the real refund engine (applyRefundSuccessData) is driven directly with the per-ticket
// amounts — the only piece the fix touches — instead of the HTTP endpoint, which would require a real
// Stripe refund against a live charge. Capacity and check-in are then asserted through the real APIs.
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../app.js';
import PaidTicket from '../models/paidTicket.js';
import { applyRefundSuccessData } from '../utils/events/refundHelpers.js';
import { calculateCurrentTicketsSold } from '../utils/events/ticketHelpers.js';
import { createOrganiser, createUser, createPaidEvent, cookieFor, API_KEY } from './helpers/factories.js';

let seq = 0;
const uniqueTn = () => `TKT-REF-${Date.now().toString(36)}-${seq++}`;

// Issue a confirmed PaidTicket straight into the DB (no Stripe), with the fields the capacity and
// check-in paths read.
const issueTicket = (event, organiser, buyer, { price = 18, invoiceNumber = 'INV-REF-0001' } = {}) =>
  PaidTicket.create({
    event: event._id.toString(),
    ticketNumber: uniqueTn(),
    invoiceNumber,
    user: buyer._id,
    eventSnapshot: { eventCode: event.eventCode, title: event.title, postedBy: organiser._id.toString() },
    ticketType: { name: 'General', price },
    priceDetails: { basePrice: price, totalPrice: price },
    buyer: { firstName: 'Bella', lastName: 'Buyer', email: buyer.email, agreedToTerms: true },
    attendees: [{ name: 'Bella Buyer' }],
    refundPolicyAcceptance: { policyType: 'non-refundable', accepted: true },
    checkInStatus: 'confirmed',
    refundStatus: 'none',
    totalRefundedAmount: 0,
  });

// Drive the real refund engine for a single ticket with a given amount (full = whole price).
const applyRefund = async (ticket, amount, organiser) => {
  const refundRequest = {
    refundAmounts: new Map([[ticket.ticketNumber, amount]]),
    stripeRefundId: 're_test',
    refundRequestId: 'REF-TEST-0001',
    reason: 'test',
    totalAmount: amount,
  };
  const invoice = {
    amounts: { total: 1000, totalRefunded: 0, netAmount: 1000 },
    refunds: [],
    status: 'paid',
    save: async () => {},
  };
  // No seats here (general admission) -> pass null so the engine's seat step is skipped.
  await applyRefundSuccessData(null, refundRequest, [ticket], invoice, organiser._id);
};

const viewCapacity = (event) =>
  request(app).get(`/api/events/${event._id}/capacity/v2?context=viewing`);

test('AC1 fully refunding one ticket on a sold-out event frees exactly one spot', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const event = await createPaidEvent(organiser, { capacity: 4, ticketTypes: [{ name: 'General', price: 18 }] });
  const tickets = [];
  for (let i = 0; i < 4; i++) tickets.push(await issueTicket(event, organiser, buyer));

  const before = await viewCapacity(event);
  expect(before.body.capacity.sold).toBe(4);
  expect(before.body.capacity.remaining).toBe(0); // sold out

  await applyRefund(tickets[0], 18, organiser); // full

  const after = await viewCapacity(event);
  expect(after.body.capacity.sold).toBe(3);
  expect(after.body.capacity.remaining).toBe(1);
});

test('AC2 a partial refund leaves the spot occupied (capacity unchanged)', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const event = await createPaidEvent(organiser, { capacity: 4, ticketTypes: [{ name: 'General', price: 18 }] });
  const ticket = await issueTicket(event, organiser, buyer);

  const before = await viewCapacity(event);
  expect(before.body.capacity.sold).toBe(1);

  await applyRefund(ticket, 5, organiser); // partial (5 of 18)

  const reloaded = await PaidTicket.findById(ticket._id);
  expect(reloaded.refundStatus).toBe('partial');
  expect(reloaded.checkInStatus).toBe('confirmed'); // still occupies its spot

  const after = await viewCapacity(event);
  expect(after.body.capacity.sold).toBe(1); // unchanged
});

test('AC3 a fully refunded ticket is cancelled and the door refuses it (TICKET_CANCELLED)', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const event = await createPaidEvent(organiser, { capacity: 4, ticketTypes: [{ name: 'General', price: 18 }] });
  const ticket = await issueTicket(event, organiser, buyer);

  await applyRefund(ticket, 18, organiser); // full

  const reloaded = await PaidTicket.findById(ticket._id);
  expect(reloaded.checkInStatus).toBe('cancelled');

  const res = await request(app)
    .post(`/api/events/${event._id}/paid/checkin-by-qr`)
    .set('Cookie', cookieFor(organiser))
    .set('x-api-key', API_KEY)
    .send({ ticketNumber: ticket.ticketNumber });
  expect(res.status).toBe(400);
  expect(res.body.errorCode).toBe('TICKET_CANCELLED');
});

test('AC4 fully refunding one member of a pack frees one spot; the rest stay confirmed and checkable', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const event = await createPaidEvent(organiser, { capacity: 10, ticketTypes: [{ name: 'FamilyFour', price: 18, bundleSize: 4 }] });
  const pack = [];
  for (let i = 0; i < 4; i++) pack.push(await issueTicket(event, organiser, buyer, { invoiceNumber: 'INV-PACK-0001' }));

  expect(await calculateCurrentTicketsSold(event._id)).toBe(4);

  await applyRefund(pack[0], 18, organiser); // full refund of one member

  expect(await calculateCurrentTicketsSold(event._id)).toBe(3); // exactly one spot freed

  // The other three remain confirmed and are not refused at the door.
  for (const t of pack.slice(1)) {
    const reloaded = await PaidTicket.findById(t._id);
    expect(reloaded.checkInStatus).toBe('confirmed');
  }
  const res = await request(app)
    .post(`/api/events/${event._id}/paid/checkin-by-qr`)
    .set('Cookie', cookieFor(organiser))
    .set('x-api-key', API_KEY)
    .send({ ticketNumber: pack[1].ticketNumber });
  expect(res.body.errorCode).not.toBe('TICKET_CANCELLED');
});
