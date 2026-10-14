// Proves the free-RSVP flow: a seeded member registers via the API; the registration lands in the
// DB and a confirmation email is captured; a duplicate registration is rejected.
import request from 'supertest';
import app from '../app.js';
import FreeTicket from '../models/freeTicket.js';
import { createOrganiser, createUser, createFreeEvent, cookieFor, API_KEY } from './helpers/factories.js';
import { getCapturedEmails, clearCapturedEmails } from '../utils/notifications/sendEmail.js';

beforeEach(() => clearCapturedEmails());

const rsvp = (event, member) =>
  request(app)
    .post(`/api/events/${event._id}/free/register`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(member))
    .send({ mobile: '0412345678', attendees: [{ name: 'Alice Attendee' }] });

test('member RSVPs a free event: DB record + confirmation email captured', async () => {
  const organiser = await createOrganiser();
  const member = await createUser({ email: 'attendee@test.dev' });
  const event = await createFreeEvent(organiser);

  const res = await rsvp(event, member);
  expect(res.status).toBeLessThan(400);
  expect(res.body.success).toBe(true);

  // Registration is in the DB.
  const tickets = await FreeTicket.countDocuments();
  expect(tickets).toBe(1);

  // A confirmation email to the attendee was produced (captured, never sent).
  const emails = getCapturedEmails();
  const confirmation = emails.find(
    (e) => e.to === 'attendee@test.dev' && /Registration Confirmed/.test(e.subject)
  );
  expect(confirmation).toBeTruthy();
  expect(confirmation.subject).toContain(event.title);
});

test('duplicate RSVP by the same member is rejected', async () => {
  const organiser = await createOrganiser();
  const member = await createUser();
  const event = await createFreeEvent(organiser);

  const first = await rsvp(event, member);
  expect(first.status).toBeLessThan(400);

  const second = await rsvp(event, member);
  expect(second.status).toBe(400);
  expect(second.body.message).toMatch(/already registered/i);
});
