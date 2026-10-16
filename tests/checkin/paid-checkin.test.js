// Paid-ticket check-in rules - see featureplans/events-paid-checkin-redesign.md. The redesign is
// frontend-only and reuses these endpoints unchanged: QR scan, the atomic double-scan guard,
// cancelled and wrong-event tickets, organiser-only access, and single/undo/bulk with roll-up.
import PaidTicket from '../../models/paidTicket.js';
import { createOrganiser, createUser, createPaidEvent, createPaidTicket } from '../helpers/factories.js';
import { api as auth } from '../helpers/eventRequests.js';

const qr = (eventId, user, ticketNumber) =>
  auth('post', `/api/events/${eventId}/paid/checkin-by-qr`, user).send({ ticketNumber });

test('scanning a valid ticket QR checks it in', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const event = await createPaidEvent(organiser);
  const ticket = await createPaidTicket(event, buyer, { ticketNumber: 'TKT-PC1' });

  const res = await qr(event._id, organiser, 'TKT-PC1');
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);

  const doc = await PaidTicket.findById(ticket._id);
  expect(doc.attendees[0].checkedIn).toBe(true);
  expect(doc.attendees[0].checkInTime).toBeTruthy();
  expect(doc.checkInStatus).toBe('checked-in');
});

test('two scans of the same ticket at the same time check it in exactly once', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const event = await createPaidEvent(organiser);
  const ticket = await createPaidTicket(event, buyer, { ticketNumber: 'TKT-PC2' });

  const [r1, r2] = await Promise.all([
    qr(event._id, organiser, 'TKT-PC2'),
    qr(event._id, organiser, 'TKT-PC2'),
  ]);
  const statuses = [r1.status, r2.status].sort();
  expect(statuses).toEqual([200, 409]);

  // Checked in exactly once.
  const doc = await PaidTicket.findById(ticket._id);
  expect(doc.attendees[0].checkedIn).toBe(true);
  expect(doc.attendees.filter((a) => a.checkedIn)).toHaveLength(1);
});

test('a cancelled ticket is refused at the door', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const event = await createPaidEvent(organiser);
  const ticket = await createPaidTicket(event, buyer, { ticketNumber: 'TKT-PC3', checkInStatus: 'cancelled' });

  const res = await qr(event._id, organiser, 'TKT-PC3');
  expect(res.status).toBe(400);
  expect(res.body.errorCode).toBe('TICKET_CANCELLED');

  const doc = await PaidTicket.findById(ticket._id);
  expect(doc.attendees[0].checkedIn).toBe(false);
});

test('a ticket for another event is refused at the door', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const eventA = await createPaidEvent(organiser);
  const eventB = await createPaidEvent(organiser);
  await createPaidTicket(eventA, buyer, { ticketNumber: 'TKT-PC4' });

  // Scan eventA's ticket against eventB's console.
  const res = await qr(eventB._id, organiser, 'TKT-PC4');
  expect(res.status).toBe(400);
  expect(res.body.errorCode).toBe('WRONG_EVENT');
});

test('only the organiser can scan, check in, undo, or bulk check in paid tickets', async () => {
  const organiser = await createOrganiser();
  const outsider = await createUser();
  const buyer = await createUser();
  const event = await createPaidEvent(organiser);
  const ticket = await createPaidTicket(event, buyer, { ticketNumber: 'TKT-PC5' });
  const attendeeId = ticket.attendees[0]._id.toString();
  const url = `/api/events/${event._id}/paid`;

  const scan = await qr(event._id, outsider, 'TKT-PC5');
  expect(scan.status).toBe(403);
  const single = await auth('patch', `${url}/checkin/${ticket._id}`, outsider).send({ attendeeId });
  expect(single.status).toBe(403);
  const undo = await auth('patch', `${url}/undo-checkin/${ticket._id}`, outsider).send({ attendeeId });
  expect(undo.status).toBe(403);
  const bulk = await auth('patch', `${url}/bulk-checkin/${ticket._id}`, outsider).send({ checkIn: true });
  expect(bulk.status).toBe(403);
});

test('check-in, undo and bulk check-in update each attendee, and the ticket is checked in only when everyone is', async () => {
  const organiser = await createOrganiser();
  const buyer = await createUser();
  const event = await createPaidEvent(organiser);
  // A ticket with two attendees, so roll-up is observable.
  const ticket = await createPaidTicket(event, buyer, {
    ticketNumber: 'TKT-PC6',
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
