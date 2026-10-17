// Not-for-sale (blocked) seats - see featureplans/events-blocked-seats.md. A blocked seat is refused by
// the buy flow, subtracted from the seated availability so sold-out is correct, untouched by the
// expired-reservation cleanup, and cannot be applied to an already-booked seat (unblocking is fine).
import Event from '../../models/eventModel.js';
import Reservation from '../../models/reservationModel.js';
import { createOrganiser, createUser, createPaidEvent } from '../helpers/factories.js';
import { api, updatePaid as putPaid } from '../helpers/eventRequests.js';
import { grid, viewCapacity } from '../helpers/seating.js';

const updatePaid = (organiser, eventId, { seatingLayout, organizerBlockedSeats }) =>
  putPaid(organiser, eventId, { seatingLayout, capacity: 10, organizerBlockedSeats });

const holdSeat = (event, buyer, seatId) => api('post', `/api/events/${event._id}/seats/hold`, buyer).send({ seatId });

test('blocked seats are not counted as available, so the event reads sold out once the rest sell', async () => {
  const org = await createOrganiser();

  // 10-seat hall, 2 marked not-for-sale -> 8 available (not 10).
  const event = await createPaidEvent(org, {
    capacity: 10,
    seatingLayout: grid(['A'], 10, { 'A-1': 'blocked', 'A-2': 'blocked' }),
  });
  const res = await viewCapacity(event);
  expect(res.status).toBe(200);
  expect(res.body.capacity.total).toBe(10);
  expect(res.body.capacity.organizerBlocked).toBe(2);
  expect(res.body.capacity.available).toBe(8);
  expect(res.body.capacity.status).toBe('available');

  // 2 blocked + the other 8 booked = 10 held; available 0 and sold-out (never "2 spots left").
  const full = await createPaidEvent(org, {
    capacity: 10,
    seatingLayout: grid(['A'], 10, {
      'A-1': 'blocked', 'A-2': 'blocked',
      'A-3': 'booked', 'A-4': 'booked', 'A-5': 'booked', 'A-6': 'booked',
      'A-7': 'booked', 'A-8': 'booked', 'A-9': 'booked', 'A-10': 'booked',
    }),
  });
  const soldOut = await viewCapacity(full);
  expect(soldOut.body.capacity.available).toBe(0);
  expect(soldOut.body.capacity.status).toBe('sold-out');
});

test('a blocked seat cannot be held for purchase', async () => {
  const org = await createOrganiser();
  const buyer = await createUser();
  const event = await createPaidEvent(org, {
    capacity: 10,
    seatingLayout: grid(['A'], 10, { 'A-1': 'blocked' }),
  });

  // Holding the blocked seat is refused.
  const blocked = await holdSeat(event, buyer, 'A-1');
  expect(blocked.status).toBe(400);
  expect(blocked.body.success).toBe(false);

  // A normal seat still holds fine.
  const ok = await holdSeat(event, buyer, 'A-2');
  expect(ok.status).toBeLessThan(400);
});

test('the expired-hold cleanup leaves blocked seats blocked', async () => {
  const org = await createOrganiser();
  const buyer = await createUser();

  // A-1 not-for-sale; A-2 a buyer selection whose hold has expired (with a matching expired reservation).
  const event = await createPaidEvent(org, {
    capacity: 10,
    seatingLayout: grid(['A'], 10, { 'A-1': 'blocked' }),
  });
  const doc = await Event.findById(event._id);
  const a2 = doc.seatingLayout[0].seats.find((s) => s.seatId === 'A-2');
  a2.status = 'selected';
  a2.reservedBy = buyer._id;
  a2.reservedUntil = new Date(Date.now() - 60 * 1000);
  await doc.save();
  await Reservation.create({
    userId: buyer._id,
    sessionId: 'sess-expired',
    eventId: event._id,
    seatIds: ['A-2'],
    status: 'active',
    expiresAt: new Date(Date.now() - 60 * 1000),
  });

  // A GET on a seated event's capacity triggers cleanupExpiredReservations first.
  await viewCapacity(event);

  const after = await Event.findById(event._id);
  const seat = (id) => after.seatingLayout[0].seats.find((s) => s.seatId === id);
  expect(seat('A-1').status).toBe('blocked');   // the not-for-sale seat is untouched
  expect(seat('A-2').status).toBe('available');  // the expired hold was freed (proves cleanup ran)
});

test('a booked seat cannot be blocked; a free seat can be blocked and unblocked', async () => {
  const org = await createOrganiser();
  const event = await createPaidEvent(org, {
    capacity: 10,
    seatingLayout: grid(['A'], 10, { 'A-3': 'booked' }),
  });

  // Mark the BOOKED seat A-3 not-for-sale -> rejected with a clear message.
  const rejected = await updatePaid(org, event._id, {
    seatingLayout: grid(['A'], 10, { 'A-3': 'booked' }),
    organizerBlockedSeats: 'A3',
  });
  expect(rejected.status).toBe(400);
  expect(rejected.body.message).toMatch(/not for sale|booked/i);

  // Mark a FREE seat A-5 not-for-sale -> accepted and re-derived to the blocked status.
  const blockOk = await updatePaid(org, event._id, {
    seatingLayout: grid(['A'], 10, { 'A-3': 'booked' }),
    organizerBlockedSeats: 'A5',
  });
  expect(blockOk.status).toBe(200);
  let after = await Event.findById(event._id);
  expect(after.seatingLayout[0].seats.find((s) => s.seatId === 'A-5').status).toBe('blocked');
  expect(after.organizerBlockedSeats).toBe('A5');

  // Unblock A-5 (empty list) -> accepted, back to available.
  const unblockOk = await updatePaid(org, event._id, {
    seatingLayout: grid(['A'], 10, { 'A-3': 'booked', 'A-5': 'blocked' }),
    organizerBlockedSeats: '',
  });
  expect(unblockOk.status).toBe(200);
  after = await Event.findById(event._id);
  expect(after.seatingLayout[0].seats.find((s) => s.seatId === 'A-5').status).toBe('available');
});
