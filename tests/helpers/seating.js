// Seat-layout builders and the capacity view, shared by the seating and capacity suites.
import request from 'supertest';
import app from '../../app.js';

// A seated grid the way the builder submits it (seatId = rowLabel-seatNumber). `statuses` is either
// one booked seat id ('A-3') or a { seatId: status } map; every other seat is available.
export const grid = (rowLabels, seatsPerRow, statuses = {}) => {
  const statusOf = typeof statuses === 'string' ? { [statuses]: 'booked' } : statuses || {};
  return rowLabels.map((label) => ({
    rowLabel: label,
    walkwayPositions: [],
    seats: Array.from({ length: seatsPerRow }, (_, i) => {
      const seatNumber = String(i + 1);
      const seatId = `${label}-${seatNumber}`;
      return { seatId, seatNumber, row: label, status: statusOf[seatId] || 'available' };
    }),
  }));
};

// A single row 'A' of `seatCount` seats WITHOUT seat ids (the server derives them), with optional
// raw walkwayPositions.
export const oneRow = (seatCount, walkwayPositions) => [{
  rowLabel: 'A',
  ...(walkwayPositions !== undefined ? { walkwayPositions } : {}),
  seats: Array.from({ length: seatCount }, (_, i) => ({ seatNumber: String(i + 1), status: 'available' })),
}];

// `n` available seats for one row, with ids.
export const rowSeats = (label, n) =>
  Array.from({ length: n }, (_, i) => ({ seatId: `${label}-${i + 1}`, seatNumber: String(i + 1), row: label, status: 'available' }));

// Seats per row of a stored event, e.g. [5, 5].
export const rowShape = (event) => (event.seatingLayout || []).map((r) => (r.seats || []).length);

// Find a seat anywhere in a stored event's layout.
export const seatById = (event, seatId) => {
  for (const row of event.seatingLayout || []) {
    const seat = row.seats.find((s) => s.seatId === seatId);
    if (seat) return seat;
  }
  return null;
};

// The public capacity view (sold / remaining / available / status). On a seated event this also
// runs the expired-reservation cleanup first.
export const viewCapacity = (event) =>
  request(app).get(`/api/events/${event._id}/capacity/v2?context=viewing`);
