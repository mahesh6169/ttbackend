// Seat holds - see featureplans/fix-events-expired-seat-release.md and fix-events-seatcount-sync.md.
// The lazy cleanup (the same traffic-triggered path the tickets/capacity endpoints run) returns an
// expired reservation's seats to the pool and leaves everything else alone; the reservation, not a
// frontend constant, decides how many seats a buyer may hold.
import Event from '../../models/eventModel.js';
import Reservation from '../../models/reservationModel.js';
import { cleanupExpiredReservations } from '../../controllers/events/reservationController.js';
import { createOrganiser, createUser, createPaidEvent } from '../helpers/factories.js';
import { api, reserve } from '../helpers/eventRequests.js';
import { rowSeats, seatById } from '../helpers/seating.js';

const past = () => new Date(Date.now() - 60_000);
const future = () => new Date(Date.now() + 60 * 60_000);

// A seated event whose seats start in the states the cleanup test needs.
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

test('the cleanup frees an expired hold\'s seats and leaves booked, still-held and organiser-held seats alone', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const buyer2 = await createUser();
  const event = await seedSeatedEvent(organiser, buyer);

  // Expired reservation holding A-1 (selected) + A-2 (reserved).
  await Reservation.create({
    userId: buyer._id, sessionId: 'sess-expired', eventId: event._id,
    seatIds: ['A-1', 'A-2'], status: 'active', expiresAt: past(),
  });
  // Active reservation holding B-1 - must be left alone.
  await Reservation.create({
    userId: buyer2._id, sessionId: 'sess-active', eventId: event._id,
    seatIds: ['B-1'], status: 'active', expiresAt: future(),
  });

  await cleanupExpiredReservations(event._id);

  const after = await Event.findById(event._id);
  // 'selected' under the expired reservation is freed, holder fields cleared.
  const a1 = seatById(after, 'A-1');
  expect(a1.status).toBe('available');
  expect(a1.reservedBy).toBeNull();
  expect(a1.reservedUntil).toBeNull();
  // 'reserved' under the expired reservation is freed too.
  const a2 = seatById(after, 'A-2');
  expect(a2.status).toBe('available');
  expect(a2.reservedBy).toBeNull();
  expect(a2.reservedUntil).toBeNull();
  // A booked (paid) seat is untouched.
  expect(seatById(after, 'A-3').status).toBe('booked');
  // The organiser's permanent hold (reservedUntil null, not in any buyer reservation) survives.
  expect(seatById(after, 'A-4').status).toBe('reserved');
  // An active reservation's seat is untouched.
  expect(seatById(after, 'B-1').status).toBe('selected');
});

test('a buyer can pick as many seats as tickets reserved, and fewer', async () => {
  const organiser = await createOrganiser();
  const member = await createUser();
  const event = await createPaidEvent(organiser, {
    ticketTypes: [{ name: 'Standard', price: 10 }],
    seatingLayout: [{ rowLabel: 'A', seats: rowSeats('A', 10) }],
    maxAttendeesPerRegistration: 8,
    capacity: 20,
  });
  const ttId = event.ticketTypes[0]._id.toString();

  // Reserve 6 tickets.
  const resv = await reserve(member, event._id, [{ ticketTypeId: ttId, quantity: 6 }]);
  expect(resv.status).toBe(200);
  const seatsUrl = `/api/events/${event._id}/reservation/${resv.body.reservationId}/seats`;

  // Adding all 6 seats (== the reservation's summed ticket quantity) is accepted - the authority is
  // the reservation, and there is no artificial cap below that count.
  const six = ['A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6'];
  const put = await api('put', seatsUrl, member).send({ seatIds: six });
  expect(put.status).toBe(200);
  expect(put.body.seatIds).toEqual(six);
  expect(put.body.seatIds).toHaveLength(6);

  // Reconciling DOWN to 4 (the buyer lowered the count) is also accepted - the endpoint stores
  // exactly what it is given.
  const down = await api('put', seatsUrl, member).send({ seatIds: ['A-1', 'A-2', 'A-3', 'A-4'] });
  expect(down.status).toBe(200);
  expect(down.body.seatIds).toHaveLength(4);
});
