// Characterization net for featureplans/events-paid-checkin-redesign.md (Stage A, AC1-AC6).
// Pins TODAY's paid check-in behaviour BEFORE the frontend redesign (the plan is frontend-only and
// reuses these endpoints unchanged). This net must stay green through the whole job.
import request from 'supertest';
import app from '../app.js';
import PaidTicket from '../models/paidTicket.js';
import { createOrganiser, createUser, createPaidEvent, createPaidTicket, cookieFor, API_KEY } from './helpers/factories.js';

const auth = (method, url, user) =>
  request(app)[method](url).set('x-api-key', API_KEY).set('Cookie', cookieFor(user));

const qr = (eventId, user, ticketNumber) =>
  auth('post', `/api/events/${eventId}/paid/checkin-by-qr`, user).send({ ticketNumber });

test('AC1 a valid QR scan checks the ticket in (attendee checkedIn + time, status -> checked-in)', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const event = await createPaidEvent(organiser);
  const ticket = await createPaidTicket(event, buyer, { ticketNumber: 'TKT-AC1' });

  const res = await qr(event._id, organiser, 'TKT-AC1');
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);

  const doc = await PaidTicket.findById(ticket._id);
  expect(doc.attendees[0].checkedIn).toBe(true);
  expect(doc.attendees[0].checkInTime).toBeTruthy();
  expect(doc.checkInStatus).toBe('checked-in');
});

test('AC2 a concurrent second QR check-in is rejected by the atomic guard and the ticket checks in exactly once', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const event = await createPaidEvent(organiser);
  const ticket = await createPaidTicket(event, buyer, { ticketNumber: 'TKT-AC2' });

  const [r1, r2] = await Promise.all([
    qr(event._id, organiser, 'TKT-AC2'),
    qr(event._id, organiser, 'TKT-AC2'),
  ]);
  const statuses = [r1.status, r2.status].sort();
  expect(statuses).toEqual([200, 409]);

  // Checked in exactly once.
  const doc = await PaidTicket.findById(ticket._id);
  expect(doc.attendees[0].checkedIn).toBe(true);
  expect(doc.attendees.filter((a) => a.checkedIn)).toHaveLength(1);
});

test('AC3 scanning a cancelled ticket returns the cancelled error and does not check in', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const event = await createPaidEvent(organiser);
  const ticket = await createPaidTicket(event, buyer, { ticketNumber: 'TKT-AC3', checkInStatus: 'cancelled' });

  const res = await qr(event._id, organiser, 'TKT-AC3');
  expect(res.status).toBe(400);
  expect(res.body.errorCode).toBe('TICKET_CANCELLED');

  const doc = await PaidTicket.findById(ticket._id);
  expect(doc.attendees[0].checkedIn).toBe(false);
});

test('AC4 scanning a ticket for another event returns the wrong-event error', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const eventA = await createPaidEvent(organiser);
  const eventB = await createPaidEvent(organiser);
  await createPaidTicket(eventA, buyer, { ticketNumber: 'TKT-AC4' });

  // Scan eventA's ticket against eventB's console.
  const res = await qr(eventB._id, organiser, 'TKT-AC4');
  expect(res.status).toBe(400);
  expect(res.body.errorCode).toBe('WRONG_EVENT');
});

test('AC5 a non-organiser is refused from every paid check-in endpoint (qr, single, undo, bulk)', async () => {
  const organiser = await createOrganiser();
  const outsider = await createUser();
  const buyer = await createUser();
  const event = await createPaidEvent(organiser);
  const ticket = await createPaidTicket(event, buyer, { ticketNumber: 'TKT-AC5' });
  const attendeeId = ticket.attendees[0]._id.toString();
  const url = `/api/events/${event._id}/paid`;

  const scan = await qr(event._id, outsider, 'TKT-AC5');
  expect(scan.status).toBe(403);
  const single = await auth('patch', `${url}/checkin/${ticket._id}`, outsider).send({ attendeeId });
  expect(single.status).toBe(403);
  const undo = await auth('patch', `${url}/undo-checkin/${ticket._id}`, outsider).send({ attendeeId });
  expect(undo.status).toBe(403);
  const bulk = await auth('patch', `${url}/bulk-checkin/${ticket._id}`, outsider).send({ checkIn: true });
  expect(bulk.status).toBe(403);
});

test('AC6 single sets checkedIn+time, undo clears, bulk sets/clears all, status rolls up only when all attendees are in', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const event = await createPaidEvent(organiser);
  // A ticket with two attendees, so roll-up is observable.
  const ticket = await createPaidTicket(event, buyer, {
    ticketNumber: 'TKT-AC6',
    attendees: [{ name: 'One', checkedIn: false }, { name: 'Two', checkedIn: false }],
  });
  const [a1, a2] = ticket.attendees.map((a) => a._id.toString());
  const url = `/api/events/${event._id}/paid`;

  // First attendee in: status stays 'confirmed' (not all in yet).
  await auth('patch', `${url}/checkin/${ticket._id}`, organiser).send({ attendeeId: a1 }).expect(200);
  let doc = await PaidTicket.findById(ticket._id);
  expect(doc.attendees.id(a1).checkedIn).toBe(true);
  expect(doc.attendees.id(a1).checkInTime).toBeTruthy();
  expect(doc.checkInStatus).toBe('confirmed');

  // Second attendee in: all in -> status 'checked-in'.
  await auth('patch', `${url}/checkin/${ticket._id}`, organiser).send({ attendeeId: a2 }).expect(200);
  doc = await PaidTicket.findById(ticket._id);
  expect(doc.checkInStatus).toBe('checked-in');

  // Undo the first: cleared, status back to 'confirmed'.
  await auth('patch', `${url}/undo-checkin/${ticket._id}`, organiser).send({ attendeeId: a1 }).expect(200);
  doc = await PaidTicket.findById(ticket._id);
  expect(doc.attendees.id(a1).checkedIn).toBe(false);
  expect(doc.attendees.id(a1).checkInTime == null).toBe(true);
  expect(doc.checkInStatus).toBe('confirmed');

  // Bulk in: everyone in, 'checked-in'.
  await auth('patch', `${url}/bulk-checkin/${ticket._id}`, organiser).send({ checkIn: true }).expect(200);
  doc = await PaidTicket.findById(ticket._id);
  expect(doc.attendees.every((a) => a.checkedIn)).toBe(true);
  expect(doc.checkInStatus).toBe('checked-in');

  // Bulk out: everyone cleared, 'confirmed'.
  await auth('patch', `${url}/bulk-checkin/${ticket._id}`, organiser).send({ checkIn: false }).expect(200);
  doc = await PaidTicket.findById(ticket._id);
  expect(doc.attendees.every((a) => !a.checkedIn)).toBe(true);
  expect(doc.checkInStatus).toBe('confirmed');
});
