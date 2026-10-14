// Seat count sync when ticket quantity changes mid-flow - see featureplans/fix-events-seatcount-sync.md.
// The count authority is the reservation, not a frontend constant: the seat-add endpoint accepts
// seats up to the reservation's summed ticket quantity and imposes no lower cap. The stale-count bug
// this job fixes is entirely frontend (proven in ttfrontend/e2e/seatcountsync.spec.js).
import request from 'supertest';
import app from '../app.js';
import { createOrganiser, createUser, createPaidEvent, cookieFor, API_KEY } from './helpers/factories.js';

const rowSeats = (label, n) =>
  Array.from({ length: n }, (_, i) => ({ seatId: `${label}-${i + 1}`, seatNumber: String(i + 1), row: label, status: 'available' }));

test('AC3 the reservation seat-add endpoint accepts seats up to the ticket count, with no lower cap', async () => {
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
  const resv = await request(app)
    .post(`/api/events/${event._id}/reservation`)
    .set('Cookie', cookieFor(member))
    .set('x-api-key', API_KEY)
    .send({ tickets: [{ ticketTypeId: ttId, quantity: 6 }] });
  expect(resv.status).toBe(200);
  const reservationId = resv.body.reservationId;

  // Adding all 6 seats (== the reservation's summed ticket quantity) is accepted - the authority is
  // the reservation, and there is no artificial cap below that count.
  const six = ['A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6'];
  const put = await request(app)
    .put(`/api/events/${event._id}/reservation/${reservationId}/seats`)
    .set('Cookie', cookieFor(member))
    .set('x-api-key', API_KEY)
    .send({ seatIds: six });
  expect(put.status).toBe(200);
  expect(put.body.seatIds).toEqual(six);
  expect(put.body.seatIds).toHaveLength(6);

  // Reconciling DOWN to 4 (the buyer lowered the count) is also accepted - the endpoint stores
  // exactly what it is given.
  const four = ['A-1', 'A-2', 'A-3', 'A-4'];
  const down = await request(app)
    .put(`/api/events/${event._id}/reservation/${reservationId}/seats`)
    .set('Cookie', cookieFor(member))
    .set('x-api-key', API_KEY)
    .send({ seatIds: four });
  expect(down.status).toBe(200);
  expect(down.body.seatIds).toHaveLength(4);
});
