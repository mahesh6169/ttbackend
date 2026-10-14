// Proves cosmetic seat-row walkways - see featureplans/events-seat-walkways.md.
// walkwayPositions is additive per-row metadata: sanitised, never a seat, and invisible to holds,
// capacity, and check-in. TRIPWIRE: nothing here touches seat status/selection/reservation/capacity.
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../app.js';
import Event from '../models/eventModel.js';
import { createOrganiser, createUser, cookieFor, API_KEY } from './helpers/factories.js';

const FUTURE = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const ADDRESS = JSON.stringify({
  formattedAddress: '1 Test St, Sydney NSW 2000', suburb: 'Sydney', state: 'NSW',
  location: { type: 'Point', coordinates: [151.2093, -33.8688] },
});

// A single row 'A' of `seatCount` seats, with optional raw walkwayPositions.
const oneRow = (seatCount, walkwayPositions) => [{
  rowLabel: 'A',
  ...(walkwayPositions !== undefined ? { walkwayPositions } : {}),
  seats: Array.from({ length: seatCount }, (_, i) => ({ seatNumber: String(i + 1), status: 'available' })),
}];

const addSeatedEvent = (organiser, { seatingLayout, capacity }) =>
  request(app)
    .post('/api/events/add-paid-event')
    .set('Cookie', cookieFor(organiser))
    .set('x-api-key', API_KEY)
    .field('title', 'Walkway Test Event')
    .field('dateTime', FUTURE())
    .field('venue', 'Test Hall')
    .field('description', 'A seeded seated event for walkway tests.')
    .field('category', 'Community')
    .field('address', ADDRESS)
    .field('organizer', JSON.stringify({ name: 'Test Organiser' }))
    .field('ticketTypes', JSON.stringify([{ name: 'Standard', price: 10 }]))
    .field('capacity', String(capacity))
    .field('maxAttendeesPerRegistration', '10')
    .field('seatingLayout', JSON.stringify(seatingLayout));

const rowA = (event) => event.seatingLayout.find((r) => r.rowLabel === 'A');

test('AC1 a 40-seat row saved with walkways [13,26] keeps them, seat ids A-1..A-40 unbroken, seats = capacity', async () => {
  const organiser = await createOrganiser();
  const res = await addSeatedEvent(organiser, { seatingLayout: oneRow(40, [13, 26]), capacity: 40 });
  expect(res.status).toBe(201);
  const event = await Event.findById(res.body.event._id);
  const row = rowA(event);
  expect([...row.walkwayPositions]).toEqual([13, 26]);
  expect(row.seats).toHaveLength(40);
  expect(row.seats.map((s) => s.seatId)).toEqual(Array.from({ length: 40 }, (_, i) => `A-${i + 1}`));
  const totalSeats = event.seatingLayout.reduce((t, r) => t + r.seats.length, 0);
  expect(totalSeats).toBe(event.capacity);
});

test('AC2 out-of-range, duplicate, and non-integer positions are sanitised to a valid list', async () => {
  const organiser = await createOrganiser();
  const res = await addSeatedEvent(organiser, { seatingLayout: oneRow(40, [0, 40, 41, 13, 13, 13.5, 26]), capacity: 40 });
  expect(res.status).toBe(201);
  const event = await Event.findById(res.body.event._id);
  expect([...rowA(event).walkwayPositions]).toEqual([13, 26]); // 0/40/41 out of range, 13.5 non-int, dup dropped
});

test('AC3 a row saved without walkways stores an empty list (old events untouched on this field)', async () => {
  const organiser = await createOrganiser();
  const res = await addSeatedEvent(organiser, { seatingLayout: oneRow(20, undefined), capacity: 20 });
  expect(res.status).toBe(201);
  const event = await Event.findById(res.body.event._id);
  expect(rowA(event).walkwayPositions).toHaveLength(0);
});

test('AC4 holding then releasing a seat adjacent to a gap behaves as any seat; no walkway leaks into seat data', async () => {
  const organiser = await createOrganiser();
  const member = await createUser();
  const created = await addSeatedEvent(organiser, { seatingLayout: oneRow(40, [13]), capacity: 40 });
  const eventId = created.body.event._id;
  const ticketTypeId = created.body.event.ticketTypes[0]._id;

  // Reserve tickets, then hold the seats straddling the gap (A-13 | A-14).
  const reservation = await request(app)
    .post(`/api/events/${eventId}/reservation`)
    .set('Cookie', cookieFor(member)).set('x-api-key', API_KEY)
    .send({ tickets: [{ ticketTypeId, quantity: 2 }] });
  expect(reservation.status).toBe(200);
  const reservationId = reservation.body.reservationId;

  const hold = await request(app)
    .put(`/api/events/${eventId}/reservation/${reservationId}/seats`)
    .set('Cookie', cookieFor(member)).set('x-api-key', API_KEY)
    .send({ seatIds: ['A-13', 'A-14'] });
  expect(hold.status).toBe(200);

  let event = await Event.findById(eventId);
  const seatStatus = (id) => rowA(event).seats.find((s) => s.seatId === id).status;
  expect(seatStatus('A-13')).toBe('selected');
  expect(seatStatus('A-14')).toBe('selected');
  // Walkway is separate metadata; no seat carries any walkway value.
  expect([...rowA(event).walkwayPositions]).toEqual([13]);
  expect(rowA(event).seats.every((s) => !('walkway' in s.toObject()))).toBe(true);

  // Release the seats.
  const release = await request(app)
    .put(`/api/events/${eventId}/reservation/${reservationId}/seats`)
    .set('Cookie', cookieFor(member)).set('x-api-key', API_KEY)
    .send({ seatIds: [] });
  expect(release.status).toBe(200);
  event = await Event.findById(eventId);
  expect(rowA(event).seats.find((s) => s.seatId === 'A-13').status).toBe('available');
});

// Aisles are a STRUCTURAL element (part of the layout fingerprint), so after a sale an aisle change is
// refused - the whole seating layout is frozen once a seat sells (events-edit-locking.md revised model:
// the hall is a fixed room; only reserving/releasing free seats stays live). Seat status and capacity
// are untouched by the refused update.
test('AC5 after a sale an aisle change is refused (the layout is frozen); seat status and capacity unchanged', async () => {
  const organiser = await createOrganiser();
  // A seated event with one already-booked seat (A-5), created straight through the model.
  const event = await Event.create({
    eventCode: `EVT-WLK-${Date.now().toString(36)}`.toUpperCase(),
    title: 'Frozen Walkway Event', description: 'seeded', category: 'Community',
    dateTime: new Date(Date.now() + 7 * 24 * 3600 * 1000), timeZone: 'Australia/Sydney',
    venue: 'Hall', address: { formattedAddress: '1 Test St', suburb: 'Sydney', state: 'NSW', location: { type: 'Point', coordinates: [151.2, -33.8] } },
    postedBy: organiser._id, isPaid: true, ticketTypes: [{ name: 'Standard', price: 10 }],
    capacity: 20, maxAttendeesPerRegistration: 10, status: 'active',
    expiryDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    organizer: { name: 'Org' },
    seatingLayout: [{
      rowLabel: 'A', walkwayPositions: [],
      seats: Array.from({ length: 20 }, (_, i) => ({
        seatId: `A-${i + 1}`, seatNumber: String(i + 1), row: 'A',
        status: i === 4 ? 'booked' : 'available',
      })),
    }],
  });

  // Attempt to add an aisle after the sale (the same wizard resend, plus the new walkway).
  const layout = [{
    rowLabel: 'A', walkwayPositions: [10],
    seats: event.seatingLayout[0].seats.map((s) => ({
      seatNumber: s.seatNumber, status: s.status,
    })),
  }];
  const res = await request(app)
    .put(`/api/events/update-paid/${event._id}`)
    .set('Cookie', cookieFor(organiser)).set('x-api-key', API_KEY)
    .field('title', 'Frozen Walkway Event')
    .field('dateTime', FUTURE())
    .field('venue', 'Hall')
    .field('description', 'seeded')
    .field('category', 'Community')
    .field('address', ADDRESS)
    .field('organizer', JSON.stringify({ name: 'Org' }))
    .field('ticketTypes', JSON.stringify([{ name: 'Standard', price: 10 }]))
    .field('capacity', '20')
    .field('maxAttendeesPerRegistration', '10')
    .field('seatingLayout', JSON.stringify(layout));
  expect(res.status).toBe(409);                 // sold -> the layout (incl. aisles) is frozen
  expect(res.body.message).toMatch(/sold/i);

  const after = await Event.findById(event._id);
  const arow = rowA(after);
  expect([...arow.walkwayPositions]).toEqual([]);        // refused -> aisle NOT added
  expect(arow.seats.find((s) => s.seatId === 'A-5').status).toBe('booked'); // sold seat untouched
  expect(arow.seats).toHaveLength(20);                    // seat count unchanged
  expect(arow.seats.filter((s) => s.status === 'booked')).toHaveLength(1);
});
