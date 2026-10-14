// FLAGSHIP: fire parallel requests at a scarce resource and assert exactly one wins. This is the
// automated version of the manual race testing the platform has always needed.
//
// FINDING (surfaced by this harness, 2026-07-28): the ONLY transaction-protected capacity guard is
// the paid confirm-payment path (ticketController withTransaction). The pre-payment paths - free
// RSVP and reservation creation - are check-then-act and OVERSELL under parallel fire. The second
// test below documents that as a known bug (test.failing keeps the suite green until it is fixed).
import request from 'supertest';
import app from '../app.js';
import User from '../models/userModel.js';
import { createOrganiser, createUser, createFreeEvent, cookieFor, API_KEY } from './helpers/factories.js';

const registration = (email) => ({
  name: 'Race Dup',
  email,
  password: 'test1234',
  confirmPassword: 'test1234',
  suburb: {
    name: 'Sydney',
    state: 'NSW',
    postalCode: '2000',
    location: { type: 'Point', coordinates: [151.2093, -33.8688] },
  },
  captchaToken: 'test-token',
});

// GREEN: proves the harness can fire parallel requests and assert exactly-one-wins on a genuinely
// atomic guard - the unique email index. Two identical registrations race; the DB lets exactly one
// persist. This is the anti-oversell primitive (unique constraint) working under Promise.all.
test('parallel identical registrations persist exactly one user (unique-index race)', async () => {
  const email = 'race-dup@test.dev';
  const fire = () => request(app).post('/api/users/register').send(registration(email)).catch(() => null);

  await Promise.all([fire(), fire()]);

  const count = await User.countDocuments({ email });
  expect(count).toBe(1);
});

// KNOWN BUG (documented, not silently passed): the free RSVP capacity check is check-then-create,
// so two parallel RSVPs for a capacity-1 event BOTH succeed. test.failing is green while the bug
// exists and will start failing the moment the free path is made atomic - prompting a fix-up.
test.failing('KNOWN OVERSELL: capacity-1 free event should let exactly one RSVP win', async () => {
  const organiser = await createOrganiser();
  const [alice, bob] = await Promise.all([
    createUser({ email: 'race-alice@test.dev' }),
    createUser({ email: 'race-bob@test.dev' }),
  ]);
  const event = await createFreeEvent(organiser, { capacity: 1 });

  const attempt = (member) =>
    request(app)
      .post(`/api/events/${event._id}/free/register`)
      .set('x-api-key', API_KEY)
      .set('Cookie', cookieFor(member))
      .send({ mobile: '0412345678', attendees: [{ name: 'Racer' }] });

  const results = await Promise.all([attempt(alice), attempt(bob)]);
  const winners = results.filter((r) => r.status < 400);

  // This is the guarantee we WANT. It fails today (both win) - which is the point of test.failing.
  expect(winners.length).toBe(1);
});
