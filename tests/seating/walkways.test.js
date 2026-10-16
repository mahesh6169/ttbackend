// Cosmetic seat-row walkways (aisles) - see featureplans/events-seat-walkways.md.
// walkwayPositions is additive per-row metadata: sanitised, never a seat, and invisible to holds,
// capacity and check-in. That an aisle change is refused after a sale is covered in
// tests/seating/layout-lock.test.js.
import Event from '../../models/eventModel.js';
import { createOrganiser, createUser } from '../helpers/factories.js';
import { api, addPaid, reserve } from '../helpers/eventRequests.js';
import { oneRow } from '../helpers/seating.js';

const rowA = (event) => event.seatingLayout.find((r) => r.rowLabel === 'A');

test('a row saved with walkways keeps them, and seat numbering and the seat count are unaffected', async () => {
  const organiser = await createOrganiser();
  const res = await addPaid(organiser, { seatingLayout: oneRow(40, [13, 26]), capacity: 40 });
  expect(res.status).toBe(201);
  const event = await Event.findById(res.body.event._id);
  const row = rowA(event);
  expect([...row.walkwayPositions]).toEqual([13, 26]);
  expect(row.seats).toHaveLength(40);
  expect(row.seats.map((s) => s.seatId)).toEqual(Array.from({ length: 40 }, (_, i) => `A-${i + 1}`));
  const totalSeats = event.seatingLayout.reduce((t, r) => t + r.seats.length, 0);
  expect(totalSeats).toBe(event.capacity);
});

test('out-of-range, duplicate and non-whole walkway positions are cleaned out', async () => {
  const organiser = await createOrganiser();
  const res = await addPaid(organiser, { seatingLayout: oneRow(40, [0, 40, 41, 13, 13, 13.5, 26]), capacity: 40 });
  expect(res.status).toBe(201);
  const event = await Event.findById(res.body.event._id);
  expect([...rowA(event).walkwayPositions]).toEqual([13, 26]); // 0/40/41 out of range, 13.5 non-int, dup dropped
});

test('a row saved without walkways stores an empty list', async () => {
  const organiser = await createOrganiser();
  const res = await addPaid(organiser, { seatingLayout: oneRow(20, undefined), capacity: 20 });
  expect(res.status).toBe(201);
  const event = await Event.findById(res.body.event._id);
  expect(rowA(event).walkwayPositions).toHaveLength(0);
});

test('seats next to a walkway hold and release like any other seat, and no seat carries walkway data', async () => {
  const organiser = await createOrganiser();
  const member = await createUser();
  const created = await addPaid(organiser, { seatingLayout: oneRow(40, [13]), capacity: 40 });
  const eventId = created.body.event._id;
  const ticketTypeId = created.body.event.ticketTypes[0]._id;

  // Reserve tickets, then hold the seats straddling the gap (A-13 | A-14).
  const reservation = await reserve(member, eventId, [{ ticketTypeId, quantity: 2 }]);
  expect(reservation.status).toBe(200);
  const reservationId = reservation.body.reservationId;

  const seatsUrl = `/api/events/${eventId}/reservation/${reservationId}/seats`;
  const hold = await api('put', seatsUrl, member).send({ seatIds: ['A-13', 'A-14'] });
  expect(hold.status).toBe(200);

  let event = await Event.findById(eventId);
  const seatStatus = (id) => rowA(event).seats.find((s) => s.seatId === id).status;
  expect(seatStatus('A-13')).toBe('selected');
  expect(seatStatus('A-14')).toBe('selected');
  // Walkway is separate metadata; no seat carries any walkway value.
  expect([...rowA(event).walkwayPositions]).toEqual([13]);
  expect(rowA(event).seats.every((s) => !('walkway' in s.toObject()))).toBe(true);

  // Release the seats.
  const release = await api('put', seatsUrl, member).send({ seatIds: [] });
  expect(release.status).toBe(200);
  event = await Event.findById(eventId);
  expect(rowA(event).seats.find((s) => s.seatId === 'A-13').status).toBe('available');
});
