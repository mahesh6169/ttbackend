// Endpoint-rule markers for featureplans/events-rsvp-checkin-redesign.md (AC12-AC14).
// The redesign is frontend-only and reuses these existing free-event endpoints unchanged;
// this suite proves the money/data rules the new UI relies on: organiser-only check-in,
// cancel-blocked-once-checked-in, and the single/undo/bulk check-in + status roll-up.
import request from 'supertest';
import app from '../app.js';
import FreeTicket from '../models/freeTicket.js';
import { createOrganiser, createUser, createFreeEvent, createFreeRegistration, cookieFor, API_KEY } from './helpers/factories.js';

const api = (method, url, user) =>
  request(app)[method](url).set('x-api-key', API_KEY).set('Cookie', cookieFor(user));

const regNumbers = (res) => res.body.registrations.map((r) => r.registrationNumber).sort();

test('AC12 a non-organiser is rejected from the single, undo, and bulk check-in endpoints', async () => {
  const organiser = await createOrganiser();
  const outsider = await createUser();
  const member = await createUser();
  const event = await createFreeEvent(organiser);
  const reg = await createFreeRegistration(event, member, {
    attendees: [{ name: 'Alice', checkedIn: false }],
  });
  const attendeeId = reg.attendees[0]._id.toString();

  const single = await api('patch', `/api/events/${event._id}/free/checkin/${reg._id}`, outsider).send({ attendeeId });
  expect(single.status).toBe(403);

  const undo = await api('patch', `/api/events/${event._id}/free/undo-checkin/${reg._id}`, outsider).send({ attendeeId });
  expect(undo.status).toBe(403);

  const bulk = await api('patch', `/api/events/${event._id}/free/bulk-checkin/${reg._id}`, outsider).send({ checkIn: true });
  expect(bulk.status).toBe(403);
});

test('AC13 cancelling a booking with a checked-in attendee is rejected (409) and the booking survives', async () => {
  const organiser = await createOrganiser();
  const member = await createUser();
  const event = await createFreeEvent(organiser);
  const reg = await createFreeRegistration(event, member, {
    attendees: [{ name: 'Bob', checkedIn: true, checkInTime: new Date() }],
  });

  const res = await api('delete', `/api/events/${event._id}/free/registration/${reg._id}`, organiser);
  expect(res.status).toBe(409);

  // The booking is still in the DB (not deleted).
  const still = await FreeTicket.findById(reg._id);
  expect(still).not.toBeNull();
});

test('LOADMORE the status filter returns pending/done bookings and stats are event-wide (whole event)', async () => {
  const organiser = await createOrganiser();
  const member = await createUser();
  const event = await createFreeEvent(organiser);
  // done x2, pending (partly) x1, pending (none) x1
  await createFreeRegistration(event, member, { registrationNumber: 'D1', attendees: [{ name: 'a', checkedIn: true, checkInTime: new Date() }] });
  await createFreeRegistration(event, member, { registrationNumber: 'D2', attendees: [{ name: 'b', checkedIn: true, checkInTime: new Date() }, { name: 'c', checkedIn: true, checkInTime: new Date() }] });
  await createFreeRegistration(event, member, { registrationNumber: 'P1', attendees: [{ name: 'd', checkedIn: true, checkInTime: new Date() }, { name: 'e', checkedIn: false }] });
  await createFreeRegistration(event, member, { registrationNumber: 'P2', attendees: [{ name: 'f', checkedIn: false }] });

  const base = `/api/events/${event._id}/free/attendees?limit=100`;

  const done = await api('get', `${base}&status=done`, organiser).expect(200);
  expect(regNumbers(done)).toEqual(['D1', 'D2']);

  const pending = await api('get', `${base}&status=pending`, organiser).expect(200);
  expect(regNumbers(pending)).toEqual(['P1', 'P2']);

  const all = await api('get', base, organiser).expect(200);
  expect(regNumbers(all)).toEqual(['D1', 'D2', 'P1', 'P2']);

  // Event-wide stats are the same on every response, regardless of the status filter or paging.
  expect(all.body.stats).toEqual({ totalRegistrations: 4, totalAttendees: 6, checkedInAttendees: 4 });
  expect(done.body.stats).toEqual({ totalRegistrations: 4, totalAttendees: 6, checkedInAttendees: 4 });
});

test('AC14 single sets checkedIn + checkInTime, undo clears both, bulk sets/clears all, status rolls up only when all are in', async () => {
  const organiser = await createOrganiser();
  const member = await createUser();
  const event = await createFreeEvent(organiser);
  const reg = await createFreeRegistration(event, member, {
    attendees: [{ name: 'Cara', checkedIn: false }, { name: 'Dan', checkedIn: false }],
  });
  const [a1, a2] = reg.attendees.map((a) => a._id.toString());
  const eventUrl = `/api/events/${event._id}/free`;

  // Check in the first attendee: it flips, and status stays 'registered' (not all in yet).
  await api('patch', `${eventUrl}/checkin/${reg._id}`, organiser).send({ attendeeId: a1 }).expect(200);
  let doc = await FreeTicket.findById(reg._id);
  const att1 = doc.attendees.id(a1);
  expect(att1.checkedIn).toBe(true);
  expect(att1.checkInTime).toBeTruthy();
  expect(doc.status).toBe('registered');

  // Check in the second: now all are in, so status rolls up to 'checkedin'.
  await api('patch', `${eventUrl}/checkin/${reg._id}`, organiser).send({ attendeeId: a2 }).expect(200);
  doc = await FreeTicket.findById(reg._id);
  expect(doc.attendees.every((a) => a.checkedIn)).toBe(true);
  expect(doc.status).toBe('checkedin');

  // Undo the first: it clears both fields and the status drops back to 'registered'.
  await api('patch', `${eventUrl}/undo-checkin/${reg._id}`, organiser).send({ attendeeId: a1 }).expect(200);
  doc = await FreeTicket.findById(reg._id);
  const undone = doc.attendees.id(a1);
  expect(undone.checkedIn).toBe(false);
  expect(undone.checkInTime == null).toBe(true);
  expect(doc.status).toBe('registered');

  // Bulk check-in: everyone in, status 'checkedin'.
  await api('patch', `${eventUrl}/bulk-checkin/${reg._id}`, organiser).send({ checkIn: true }).expect(200);
  doc = await FreeTicket.findById(reg._id);
  expect(doc.attendees.every((a) => a.checkedIn)).toBe(true);
  expect(doc.status).toBe('checkedin');

  // Bulk check-out: everyone cleared, status 'registered'.
  await api('patch', `${eventUrl}/bulk-checkin/${reg._id}`, organiser).send({ checkIn: false }).expect(200);
  doc = await FreeTicket.findById(reg._id);
  expect(doc.attendees.every((a) => !a.checkedIn)).toBe(true);
  expect(doc.status).toBe('registered');
});
