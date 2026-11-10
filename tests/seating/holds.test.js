// Seat holds - see featureplans/fix-events-expired-seat-release.md and fix-events-seatcount-sync.md.
// The lazy cleanup (the same traffic-triggered path the tickets/capacity endpoints run) returns an
// expired reservation's seats to the pool and leaves everything else alone; the reservation, not a
// frontend constant, decides how many seats a buyer may hold.
import Event from '../../models/eventModel.js';
import Reservation from '../../models/reservationModel.js';
import { cleanupExpiredReservations } from '../../controllers/events/reservationController.js';
import { createOrganiser, createUser, createPaidEvent } from '../helpers/factories.js';
import { api, reserve, createHoldPaymentIntent, authoriseWithTestCard, confirmPurchase, sendStripeWebhook, stripePayment } from '../helpers/eventRequests.js';
import PaidTicket from '../../models/paidTicket.js';
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

// ---- Seats when a paid order is made or released (feature 1015) ----

// A seated event (row A, 4 seats) where each buyer already holds the given seats, the way the seat
// picker leaves them: seat 'selected' by the buyer + an active reservation listing those seats.
const seatedWithHolds = async (organiser, holds) => {
  const holder = {};
  for (const [buyer, ids] of holds) for (const id of ids) holder[id] = buyer;
  const seats = ['A-1', 'A-2', 'A-3', 'A-4'].map((seatId, i) => ({
    seatId, seatNumber: String(i + 1), row: 'A',
    ...(holder[seatId]
      ? { status: 'selected', reservedBy: holder[seatId]._id, reservedUntil: future(), sessionId: `s-${holder[seatId]._id}` }
      : { status: 'available' }),
  }));
  const event = await createPaidEvent(organiser, { capacity: 4, seatingLayout: [{ rowLabel: 'A', seats }] });
  for (const [buyer, ids] of holds) {
    await Reservation.create({ userId: buyer._id, sessionId: `s-${buyer._id}`, eventId: event._id, seatIds: ids, status: 'active', expiresAt: future() });
  }
  return event;
};

const payForSeats = async (buyer, event, qty) => {
  const pay = await createHoldPaymentIntent(buyer, event._id, { [event.ticketTypes[0]._id.toString()]: qty });
  expect(pay.status).toBe(200);
  await authoriseWithTestCard(pay.body.paymentIntentId);
  return pay.body.paymentIntentId;
};

describe('seats when a paid order is made or released', () => {
  test('Stripe\'s message books the held seats and closes the buyer\'s hold (page closed after paying)', async () => {
    const organiser = await createOrganiser();
    const buyer = await createUser();
    const event = await seatedWithHolds(organiser, [[buyer, ['A-1', 'A-2']]]);
    const piId = await payForSeats(buyer, event, 2);

    expect((await sendStripeWebhook('payment_intent.amount_capturable_updated', piId)).status).toBe(200);

    const after = await Event.findById(event._id);
    expect(seatById(after, 'A-1').status).toBe('booked');
    expect(seatById(after, 'A-2').status).toBe('booked');
    const tickets = await PaidTicket.find({ paymentIntentId: piId });
    expect(tickets.map((t) => t.seats[0].seatId).sort()).toEqual(['A-1', 'A-2']);
    expect(await Reservation.countDocuments({ eventId: event._id, userId: buyer._id })).toBe(0);
  }, 60000);

  test('a seat taken by someone else while paying: not charged, and the buyer\'s other held seat is freed at once', async () => {
    const organiser = await createOrganiser();
    const buyer = await createUser();
    const other = await createUser();
    const event = await seatedWithHolds(organiser, [[buyer, ['A-1', 'A-2']]]);
    const piId = await payForSeats(buyer, event, 2);
    await Event.updateOne({ _id: event._id }, { $set: { 'seatingLayout.0.seats.1.status': 'booked', 'seatingLayout.0.seats.1.reservedBy': other._id } });

    const res = await confirmPurchase(buyer, event._id, piId);
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('SEAT_TAKEN');
    expect((await stripePayment(piId)).status).toBe('canceled');

    const after = await Event.findById(event._id);
    expect(seatById(after, 'A-1').status).toBe('available');
    expect(String(seatById(after, 'A-2').reservedBy)).toBe(String(other._id)); // the other buyer keeps theirs
    expect(await PaidTicket.countDocuments({ paymentIntentId: piId })).toBe(0);
    expect(await Reservation.countDocuments({ eventId: event._id, userId: buyer._id })).toBe(0);
  }, 60000);

  test('the seat hold ran out but the seats are still free: the buyer still gets them', async () => {
    const organiser = await createOrganiser();
    const buyer = await createUser();
    const event = await seatedWithHolds(organiser, [[buyer, ['A-3']]]);
    const piId = await payForSeats(buyer, event, 1);
    // The hold expired and the clean-up freed the seat, nobody took it.
    await Event.updateOne({ _id: event._id }, { $set: { 'seatingLayout.0.seats.2.status': 'available', 'seatingLayout.0.seats.2.reservedBy': null, 'seatingLayout.0.seats.2.reservedUntil': null } });

    const res = await confirmPurchase(buyer, event._id, piId);
    const after = await Event.findById(event._id);
    expect(res.status).toBe(200);
    expect(seatById(after, 'A-3').status).toBe('booked');
    expect(String(seatById(after, 'A-3').reservedBy)).toBe(String(buyer._id));
  }, 60000);

  test('two buyers finishing at the same moment each get their own seats - neither booking overwrites the other', async () => {
    const organiser = await createOrganiser();
    const a = await createUser();
    const b = await createUser();
    const event = await seatedWithHolds(organiser, [[a, ['A-1']], [b, ['A-4']]]);
    const piA = await payForSeats(a, event, 1);
    const piB = await payForSeats(b, event, 1);

    const [ra, rb] = await Promise.all([confirmPurchase(a, event._id, piA), confirmPurchase(b, event._id, piB)]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    const after = await Event.findById(event._id);
    expect(seatById(after, 'A-1')).toMatchObject({ status: 'booked' });
    expect(seatById(after, 'A-4')).toMatchObject({ status: 'booked' });
    expect(String(seatById(after, 'A-1').reservedBy)).toBe(String(a._id));
    expect(String(seatById(after, 'A-4').reservedBy)).toBe(String(b._id));
  }, 60000);
});
