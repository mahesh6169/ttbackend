// Proves expired reservations return their seats to the pool — see featureplans/fix-events-expired-seat-release.md.
// Written truth-first: AC2 (the open question) drives whether a fix is needed. The lazy cleanup is the
// same traffic-triggered path that runs on the tickets/capacity endpoints.
import mongoose from 'mongoose';
import Event from '../models/eventModel.js';
import Reservation from '../models/reservationModel.js';
import { cleanupExpiredReservations } from '../controllers/events/reservationController.js';
import { createOrganiser, createUser, createPaidEvent } from './helpers/factories.js';

const past = () => new Date(Date.now() - 60_000);
const future = () => new Date(Date.now() + 60 * 60_000);

// A seated event whose seats start in the states each AC needs.
const seedSeatedEvent = async (organiser, buyer) => {
  const seatingLayout = [
    {
      rowLabel: 'A',
      seats: [
        // Expired buyer reservation holds A-1 (selected) and A-2 (reserved).
        { seatId: 'A-1', seatNumber: '1', row: 'A', status: 'selected', reservedBy: buyer._id, reservedUntil: past(), sessionId: 'sess-expired' },
        { seatId: 'A-2', seatNumber: '2', row: 'A', status: 'reserved', reservedBy: buyer._id, reservedUntil: past(), sessionId: 'sess-expired' },
        // A paid seat and an organiser hold (permanent, reservedUntil null) must both survive.
        { seatId: 'A-3', seatNumber: '3', row: 'A', status: 'booked', reservedBy: buyer._id, reservedUntil: null, sessionId: null },
        { seatId: 'A-4', seatNumber: '4', row: 'A', status: 'reserved', reservedBy: organiser._id, reservedUntil: null, sessionId: null },
      ],
    },
    {
      rowLabel: 'B',
      // An active (unexpired) reservation holds B-1.
      seats: [{ seatId: 'B-1', seatNumber: '1', row: 'B', status: 'selected', reservedBy: buyer._id, reservedUntil: future(), sessionId: 'sess-active' }],
    },
  ];
  return createPaidEvent(organiser, { capacity: 5, seatingLayout });
};

const seatById = (event, id) => {
  for (const row of event.seatingLayout) {
    const s = row.seats.find((x) => x.seatId === id);
    if (s) return s;
  }
  return null;
};

test('AC1-AC4 cleanup frees an expired reservation\'s selected AND reserved seats, and leaves booked, active, and organiser seats alone', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const buyer2 = await createUser();
  const event = await seedSeatedEvent(organiser, buyer);

  // Expired reservation holding A-1 (selected) + A-2 (reserved).
  await Reservation.create({
    userId: buyer._id, sessionId: 'sess-expired', eventId: event._id,
    seatIds: ['A-1', 'A-2'], status: 'active', expiresAt: past(),
  });
  // Active reservation holding B-1 — must be left alone.
  await Reservation.create({
    userId: buyer2._id, sessionId: 'sess-active', eventId: event._id,
    seatIds: ['B-1'], status: 'active', expiresAt: future(),
  });

  await cleanupExpiredReservations(event._id);

  const after = await Event.findById(event._id);
  // AC1: 'selected' under the expired reservation is freed, holder fields cleared.
  const a1 = seatById(after, 'A-1');
  expect(a1.status).toBe('available');
  expect(a1.reservedBy).toBeNull();
  expect(a1.reservedUntil).toBeNull();
  // AC2 (the question): 'reserved' under the expired reservation is freed too.
  const a2 = seatById(after, 'A-2');
  expect(a2.status).toBe('available');
  expect(a2.reservedBy).toBeNull();
  expect(a2.reservedUntil).toBeNull();
  // AC3: a booked (paid) seat is untouched.
  expect(seatById(after, 'A-3').status).toBe('booked');
  // Organiser's permanent hold (reservedUntil null, not in any buyer reservation) survives.
  expect(seatById(after, 'A-4').status).toBe('reserved');
  // AC4: an active reservation's seat is untouched.
  expect(seatById(after, 'B-1').status).toBe('selected');
});
