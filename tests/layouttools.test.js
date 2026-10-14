// events-layout-tools.md AC5 - the Layout tools (horizontal flip, skip-rows) change seat position or
// identity, so both are locked once any seat is booked and free before. Flip has an explicit orientation
// lock; a skip-driven row relabel is a structural layout change caught by the existing seat-sale lock.
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

const updatePaid = (organiser, eventId, { seatingLayout, capacity = 100, flipH }) => {
  const req = request(app)
    .put(`/api/events/update-paid/${eventId}`)
    .set('Cookie', cookieFor(organiser))
    .set('x-api-key', API_KEY)
    .field('title', 'Layout Tools Test')
    .field('dateTime', FUTURE())
    .field('venue', 'Test Hall')
    .field('description', 'A seeded paid event for layout-tool lock tests.')
    .field('category', 'Community')
    .field('address', ADDRESS)
    .field('organizer', JSON.stringify({ name: 'Test Organiser' }))
    .field('ticketTypes', JSON.stringify([{ name: 'Standard', price: 10 }]))
    .field('capacity', String(capacity))
    .field('maxAttendeesPerRegistration', '10')
    .field('seatingLayout', JSON.stringify(seatingLayout));
  if (flipH !== undefined) req.field('seatingLayoutFlipH', flipH ? 'true' : 'false');
  return req;
};

test('AC5 a horizontal flip is rejected once a seat is booked, and accepted (persisted) with no bookings', async () => {
  const org = await createOrganiser();

  // Booked event: turning the flip on is refused, and the stored flag stays false.
  const booked = await createPaidEvent(org, { capacity: 10, seatingLayout: grid(['A'], 10, 'A-3') });
  const rejected = await updatePaid(org, booked._id, { seatingLayout: grid(['A'], 10, 'A-3'), capacity: 10, flipH: true });
  expect(rejected.status).toBe(409);
  expect(rejected.body.message).toMatch(/orientation is locked/i);
  expect((await Event.findById(booked._id)).seatingLayoutFlipH).toBe(false);

  // Clean event: the flip is accepted and persists as a boolean flag (no seat data changed).
  const clean = await createPaidEvent(org, { capacity: 10, seatingLayout: grid(['A'], 10) });
  const ok = await updatePaid(org, clean._id, { seatingLayout: grid(['A'], 10), capacity: 10, flipH: true });
  expect(ok.status).toBe(200);
  expect((await Event.findById(clean._id)).seatingLayoutFlipH).toBe(true);
});

test('AC5 a skip-driven row relabel is rejected once a seat is booked, and accepted with no bookings', async () => {
  const org = await createOrganiser();

  // Booked event: relabeling rows (as a skip regeneration would - B becomes C) changes seat ids, a
  // structural change, so it is refused; the stored labels are untouched.
  const booked = await createPaidEvent(org, { capacity: 20, seatingLayout: grid(['A', 'B'], 10, 'A-3') });
  const rejected = await updatePaid(org, booked._id, { seatingLayout: grid(['A', 'C'], 10, 'A-3'), capacity: 20 });
  expect(rejected.status).toBe(409);
  const after = await Event.findById(booked._id);
  expect(after.seatingLayout.map((r) => r.rowLabel)).toEqual(['A', 'B']);

  // Clean event: the same relabel is accepted.
  const clean = await createPaidEvent(org, { capacity: 20, seatingLayout: grid(['A', 'B'], 10) });
  const ok = await updatePaid(org, clean._id, { seatingLayout: grid(['A', 'C'], 10), capacity: 20 });
  expect(ok.status).toBe(200);
  expect((await Event.findById(clean._id)).seatingLayout.map((r) => r.rowLabel)).toEqual(['A', 'C']);
});
