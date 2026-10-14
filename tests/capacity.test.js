// Proves the capacity endpoint reflects real registrations: numbers move as attendees are added.
import request from 'supertest';
import app from '../app.js';
import { createOrganiser, createUser, createFreeEvent, cookieFor, API_KEY } from './helpers/factories.js';

const getCapacity = (event) =>
  request(app).get(`/api/events/${event._id}/capacity/v2?context=viewing`);

test('capacity reflects registrations as they are created', async () => {
  const organiser = await createOrganiser();
  const member = await createUser();
  const event = await createFreeEvent(organiser, { capacity: 10 });

  const before = await getCapacity(event);
  expect(before.status).toBe(200);
  expect(before.body.capacity.total).toBe(10);
  expect(before.body.capacity.sold).toBe(0);
  expect(before.body.capacity.remaining).toBe(10);
  expect(before.body.capacity.status).toBe('available');

  // Register two attendees on one RSVP.
  const rsvp = await request(app)
    .post(`/api/events/${event._id}/free/register`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(member))
    .send({ mobile: '0412345678', attendees: [{ name: 'A One' }, { name: 'B Two' }] });
  expect(rsvp.status).toBeLessThan(400);

  const after = await getCapacity(event);
  expect(after.body.capacity.sold).toBe(2);
  expect(after.body.capacity.remaining).toBe(8);
});
