// Seat configuration locks on first sale, free before it - see featureplans/fix-events-seatmap-salelock.md.
// The paid-event update endpoint refuses a STRUCTURAL seating-layout change once a sale (or a live hold)
// exists, and freely replaces the layout while the event is clean.
import request from 'supertest';
import app from '../app.js';
import Event from '../models/eventModel.js';
import { createOrganiser, createPaidEvent, cookieFor, API_KEY } from './helpers/factories.js';

const FUTURE = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const ADDRESS = JSON.stringify({
  formattedAddress: '1 Test St, Sydney NSW 2000',
  suburb: 'Sydney', state: 'NSW',
  location: { type: 'Point', coordinates: [151.2093, -33.8688] },
});

// A plain seated grid the way the builder submits it (seatId = rowLabel-seatNumber).
const grid = (rowLabels, seatsPerRow, bookedSeatId = null) =>
  rowLabels.map((label) => ({
    rowLabel: label,
    walkwayPositions: [],
    seats: Array.from({ length: seatsPerRow }, (_, i) => {
      const seatNumber = String(i + 1);
      const seatId = `${label}-${seatNumber}`;
      return { seatId, seatNumber, row: label, status: seatId === bookedSeatId ? 'booked' : 'available' };
    }),
  }));

const updatePaid = (organiser, eventId, { title = 'Seat Lock Test', seatingLayout, capacity = 100 }) =>
  request(app)
    .put(`/api/events/update-paid/${eventId}`)
    .set('Cookie', cookieFor(organiser))
    .set('x-api-key', API_KEY)
    .field('title', title)
    .field('dateTime', FUTURE())
    .field('venue', 'Test Hall')
    .field('description', 'A seeded paid event for sale-lock tests.')
    .field('category', 'Community')
    .field('address', ADDRESS)
    .field('organizer', JSON.stringify({ name: 'Test Organiser' }))
    .field('ticketTypes', JSON.stringify([{ name: 'Standard', price: 10 }]))
    .field('capacity', String(capacity))
    .field('maxAttendeesPerRegistration', '10')
    .field('seatingLayout', JSON.stringify(seatingLayout));

const rowShape = (event) => (event.seatingLayout || []).map((r) => (r.seats || []).length);

test('AC1 an UNSOLD seated event accepts a restructured layout; the stored layout becomes the new one', async () => {
  const org = await createOrganiser();
  const event = await createPaidEvent(org, { capacity: 100, seatingLayout: grid(['A', 'B'], 5) });

  const res = await updatePaid(org, event._id, { seatingLayout: grid(['A', 'B', 'C'], 8) });

  expect(res.status).toBe(200);
  const after = await Event.findById(event._id);
  expect(rowShape(after)).toEqual([8, 8, 8]); // 3 rows of 8 - the new layout
});

test('AC2 a SOLD seated event refuses a restructured layout with a clear message; the stored layout is unchanged', async () => {
  const org = await createOrganiser();
  const event = await createPaidEvent(org, { capacity: 100, seatingLayout: grid(['A', 'B'], 5, 'A-3') });

  const res = await updatePaid(org, event._id, { seatingLayout: grid(['A', 'B', 'C'], 8) });

  expect(res.status).toBe(409);
  expect(res.body.message).toMatch(/sold/i);
  const after = await Event.findById(event._id);
  expect(rowShape(after)).toEqual([5, 5]); // untouched
  const a3 = after.seatingLayout[0].seats.find((s) => s.seatId === 'A-3');
  expect(a3.status).toBe('booked'); // the sale survived
});

test('AC3 the SAME sold event accepts a title-only update that leaves the layout structure intact', async () => {
  const org = await createOrganiser();
  const event = await createPaidEvent(org, { capacity: 100, seatingLayout: grid(['A', 'B'], 5, 'A-3') });

  // Re-submit the identical structure (the builder round-trips it) with a new title.
  const res = await updatePaid(org, event._id, { title: 'Renamed Fest', seatingLayout: grid(['A', 'B'], 5, 'A-3') });

  expect(res.status).toBe(200);
  const after = await Event.findById(event._id);
  expect(after.title).toBe('Renamed Fest');
  expect(rowShape(after)).toEqual([5, 5]);
  expect(after.seatingLayout[0].seats.find((s) => s.seatId === 'A-3').status).toBe('booked');
});

test('AC4 an UNSOLD event with a LIVE hold refuses a restructure with the try-again message; it succeeds once the hold clears', async () => {
  const org = await createOrganiser();
  const event = await createPaidEvent(org, { capacity: 100, seatingLayout: grid(['A', 'B'], 5) });

  // Place a live attendee hold on seat A-1 (unexpired reservedUntil).
  const held = await Event.findById(event._id);
  held.seatingLayout[0].seats[0].status = 'selected';
  held.seatingLayout[0].seats[0].reservedUntil = new Date(Date.now() + 5 * 60 * 1000);
  await held.save();

  const refused = await updatePaid(org, event._id, { seatingLayout: grid(['A', 'B', 'C'], 8) });
  expect(refused.status).toBe(409);
  expect(refused.body.message).toMatch(/again/i);
  expect(rowShape(await Event.findById(event._id))).toEqual([5, 5]); // untouched while held

  // Release the hold; the same restructure now succeeds.
  const cleared = await Event.findById(event._id);
  cleared.seatingLayout[0].seats[0].status = 'available';
  cleared.seatingLayout[0].seats[0].reservedUntil = null;
  await cleared.save();

  const ok = await updatePaid(org, event._id, { seatingLayout: grid(['A', 'B', 'C'], 8) });
  expect(ok.status).toBe(200);
  expect(rowShape(await Event.findById(event._id))).toEqual([8, 8, 8]);
});
