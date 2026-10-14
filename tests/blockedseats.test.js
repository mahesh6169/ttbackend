// events-blocked-seats.md - not-for-sale (blocked) seats: refused by the buy flow (AC2), subtracted
// from the seated availability so sold-out is correct (AC3), untouched by the expired-reservation
// cleanup (AC4), and blocking an already-booked seat is rejected while unblocking is accepted (AC5).
import request from 'supertest';
import app from '../app.js';
import Event from '../models/eventModel.js';
import Reservation from '../models/reservationModel.js';
import { createOrganiser, createUser, createPaidEvent, cookieFor, API_KEY } from './helpers/factories.js';

const FUTURE = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const ADDRESS = JSON.stringify({
  formattedAddress: '1 Test St, Sydney NSW 2000',
  suburb: 'Sydney', state: 'NSW',
  location: { type: 'Point', coordinates: [151.2093, -33.8688] },
});

// A single-row hall the way the builder submits it; `statuses` is a { seatId: status } override map.
const grid = (label, seatsPerRow, statuses = {}) => ([{
  rowLabel: label,
  walkwayPositions: [],
  seats: Array.from({ length: seatsPerRow }, (_, i) => {
    const seatNumber = String(i + 1);
    const seatId = `${label}-${seatNumber}`;
    return { seatId, seatNumber, row: label, status: statuses[seatId] || 'available' };
  }),
}]);

const capacityViewing = (event) =>
  request(app).get(`/api/events/${event._id}/capacity/v2?context=viewing`);

const updatePaid = (organiser, eventId, { seatingLayout, capacity = 10, organizerBlockedSeats }) => {
  const req = request(app)
    .put(`/api/events/update-paid/${eventId}`)
    .set('Cookie', cookieFor(organiser))
    .set('x-api-key', API_KEY)
    .field('title', 'Blocked Seats Test')
    .field('dateTime', FUTURE())
    .field('venue', 'Test Hall')
    .field('description', 'A seeded paid event for blocked-seat tests.')
    .field('category', 'Community')
    .field('address', ADDRESS)
    .field('organizer', JSON.stringify({ name: 'Test Organiser' }))
    .field('ticketTypes', JSON.stringify([{ name: 'Standard', price: 10 }]))
    .field('capacity', String(capacity))
    .field('maxAttendeesPerRegistration', '10')
    .field('seatingLayout', JSON.stringify(seatingLayout));
  if (organizerBlockedSeats !== undefined) req.field('organizerBlockedSeats', organizerBlockedSeats);
  return req;
};

test('AC3 the seated available count subtracts blocked; once the rest sell the event reads sold out', async () => {
  const org = await createOrganiser();

  // 10-seat hall, 2 marked not-for-sale -> 8 available (not 10).
  const event = await createPaidEvent(org, {
    capacity: 10,
    seatingLayout: grid('A', 10, { 'A-1': 'blocked', 'A-2': 'blocked' }),
  });
  const res = await capacityViewing(event);
  expect(res.status).toBe(200);
  expect(res.body.capacity.total).toBe(10);
  expect(res.body.capacity.organizerBlocked).toBe(2);
  expect(res.body.capacity.available).toBe(8);
  expect(res.body.capacity.status).toBe('available');

  // 2 blocked + the other 8 booked = 10 held; available 0 and sold-out (never "2 spots left").
  const full = await createPaidEvent(org, {
    capacity: 10,
    seatingLayout: grid('A', 10, {
      'A-1': 'blocked', 'A-2': 'blocked',
      'A-3': 'booked', 'A-4': 'booked', 'A-5': 'booked', 'A-6': 'booked',
      'A-7': 'booked', 'A-8': 'booked', 'A-9': 'booked', 'A-10': 'booked',
    }),
  });
  const soldOut = await capacityViewing(full);
  expect(soldOut.body.capacity.available).toBe(0);
  expect(soldOut.body.capacity.status).toBe('sold-out');
});

test('AC2 the buy flow refuses a blocked seat (it is not available)', async () => {
  const org = await createOrganiser();
  const buyer = await createUser();
  const event = await createPaidEvent(org, {
    capacity: 10,
    seatingLayout: grid('A', 10, { 'A-1': 'blocked' }),
  });

  // Holding the blocked seat is refused.
  const blocked = await request(app)
    .post(`/api/events/${event._id}/seats/hold`)
    .set('Cookie', cookieFor(buyer))
    .set('x-api-key', API_KEY)
    .send({ seatId: 'A-1' });
  expect(blocked.status).toBe(400);
  expect(blocked.body.success).toBe(false);

  // A normal seat still holds fine.
  const ok = await request(app)
    .post(`/api/events/${event._id}/seats/hold`)
    .set('Cookie', cookieFor(buyer))
    .set('x-api-key', API_KEY)
    .send({ seatId: 'A-2' });
  expect(ok.status).toBeLessThan(400);
});

test('AC4 the expired-reservation cleanup does not change a blocked seat', async () => {
  const org = await createOrganiser();
  const buyer = await createUser();

  // A-1 not-for-sale; A-2 a buyer selection whose hold has expired (with a matching expired reservation).
  const event = await createPaidEvent(org, {
    capacity: 10,
    seatingLayout: grid('A', 10, { 'A-1': 'blocked' }),
  });
  const doc = await Event.findById(event._id);
  const a2 = doc.seatingLayout[0].seats.find((s) => s.seatId === 'A-2');
  a2.status = 'selected';
  a2.reservedBy = buyer._id;
  a2.reservedUntil = new Date(Date.now() - 60 * 1000);
  await doc.save();
  await Reservation.create({
    userId: buyer._id,
    sessionId: 'sess-ac4',
    eventId: event._id,
    seatIds: ['A-2'],
    status: 'active',
    expiresAt: new Date(Date.now() - 60 * 1000),
  });

  // A GET on a seated event's capacity triggers cleanupExpiredReservations first.
  await capacityViewing(event);

  const after = await Event.findById(event._id);
  const seat = (id) => after.seatingLayout[0].seats.find((s) => s.seatId === id);
  expect(seat('A-1').status).toBe('blocked');   // the not-for-sale seat is untouched
  expect(seat('A-2').status).toBe('available');  // the expired hold was freed (proves cleanup ran)
});

test('AC5 blocking a booked seat is rejected; unblocking a blocked seat is accepted', async () => {
  const org = await createOrganiser();
  const event = await createPaidEvent(org, {
    capacity: 10,
    seatingLayout: grid('A', 10, { 'A-3': 'booked' }),
  });

  // Mark the BOOKED seat A-3 not-for-sale -> rejected with a clear message.
  const rejected = await updatePaid(org, event._id, {
    seatingLayout: grid('A', 10, { 'A-3': 'booked' }),
    organizerBlockedSeats: 'A3',
  });
  expect(rejected.status).toBe(400);
  expect(rejected.body.message).toMatch(/not for sale|booked/i);

  // Mark a FREE seat A-5 not-for-sale -> accepted and re-derived to the blocked status.
  const blockOk = await updatePaid(org, event._id, {
    seatingLayout: grid('A', 10, { 'A-3': 'booked' }),
    organizerBlockedSeats: 'A5',
  });
  expect(blockOk.status).toBe(200);
  let after = await Event.findById(event._id);
  expect(after.seatingLayout[0].seats.find((s) => s.seatId === 'A-5').status).toBe('blocked');
  expect(after.organizerBlockedSeats).toBe('A5');

  // Unblock A-5 (empty list) -> accepted, back to available.
  const unblockOk = await updatePaid(org, event._id, {
    seatingLayout: grid('A', 10, { 'A-3': 'booked', 'A-5': 'blocked' }),
    organizerBlockedSeats: '',
  });
  expect(unblockOk.status).toBe(200);
  after = await Event.findById(event._id);
  expect(after.seatingLayout[0].seats.find((s) => s.seatId === 'A-5').status).toBe('available');
});
