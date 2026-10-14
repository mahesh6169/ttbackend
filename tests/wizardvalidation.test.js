// Server backstop for the create-event wizard - see featureplans/events-wizard-validation.md.
// The wizard enforces these inline; these prove the endpoint is the wall for the money/correctness
// fundamentals (AC22-AC25). The layered UI validation itself is proven in
// ttfrontend/e2e/wizardvalidation.spec.js.
import request from 'supertest';
import app from '../app.js';
import { createOrganiser, cookieFor, API_KEY } from './helpers/factories.js';

const FUTURE = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const PAST = () => new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const ADDRESS = JSON.stringify({
  formattedAddress: '1 Test St, Sydney NSW 2000',
  suburb: 'Sydney',
  state: 'NSW',
  location: { type: 'Point', coordinates: [151.2093, -33.8688] },
});

// POST the real add-free-event endpoint (multipart, like the wizard).
const addFreeEvent = (organiser, overrides = {}) => {
  const {
    dateTime = FUTURE(),
    eventIntent = 'host',
    externalTicketUrl,
  } = overrides;
  const req = request(app)
    .post('/api/events/add-free-event')
    .set('Cookie', cookieFor(organiser))
    .set('x-api-key', API_KEY)
    .field('title', 'Wizard Validation Event')
    .field('dateTime', dateTime)
    .field('venue', 'Test Hall')
    .field('description', 'A seeded event for wizard-validation tests.')
    .field('category', 'Community')
    .field('address', ADDRESS)
    .field('organizer', JSON.stringify({ name: 'Test Organiser' }))
    .field('eventIntent', eventIntent);
  if (externalTicketUrl !== undefined) req.field('externalTicketUrl', externalTicketUrl);
  return req;
};

// POST the real add-paid-event endpoint.
const addPaidEvent = (organiser, overrides = {}) => {
  const {
    ticketTypes = JSON.stringify([{ name: 'Standard', price: 10 }]),
    dateTime = FUTURE(),
    capacity = 100,
    maxAttendeesPerRegistration = 5,
  } = overrides;
  const req = request(app)
    .post('/api/events/add-paid-event')
    .set('Cookie', cookieFor(organiser))
    .set('x-api-key', API_KEY)
    .field('title', 'Wizard Validation Paid Event')
    .field('dateTime', dateTime)
    .field('venue', 'Test Hall')
    .field('description', 'A seeded paid event for wizard-validation tests.')
    .field('category', 'Community')
    .field('address', ADDRESS)
    .field('organizer', JSON.stringify({ name: 'Test Organiser' }))
    .field('capacity', String(capacity))
    .field('maxAttendeesPerRegistration', String(maxAttendeesPerRegistration));
  if (ticketTypes !== null) req.field('ticketTypes', ticketTypes);
  return req;
};

test('AC22 the create endpoint rejects an event with a past date', async () => {
  const organiser = await createOrganiser();
  const res = await addFreeEvent(organiser, { dateTime: PAST() });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/future/i);

  // And a future date is accepted (control).
  const ok = await addFreeEvent(organiser, { dateTime: FUTURE() });
  expect(ok.status).toBe(201);
});

test('AC23 the create endpoint rejects a paid event with zero ticket types (empty and absent)', async () => {
  const organiser = await createOrganiser();

  const empty = await addPaidEvent(organiser, { ticketTypes: JSON.stringify([]) });
  expect(empty.status).toBe(400);
  expect(empty.body.message).toMatch(/ticket type/i);

  const absent = await addPaidEvent(organiser, { ticketTypes: null });
  expect(absent.status).toBe(400);
  expect(absent.body.message).toMatch(/ticket type/i);
});

test('AC24 the create endpoint rejects a ticket price below $1', async () => {
  const organiser = await createOrganiser();
  const res = await addPaidEvent(organiser, { ticketTypes: JSON.stringify([{ name: 'Cheap', price: 0.5 }]) });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/minimum ticket price is \$1/i);
});

test('AC25 the create endpoint rejects a promo event without a valid https external URL', async () => {
  const organiser = await createOrganiser();

  const missing = await addFreeEvent(organiser, { eventIntent: 'promote' });
  expect(missing.status).toBe(400);
  expect(missing.body.message).toMatch(/https|external/i);

  const httpOnly = await addFreeEvent(organiser, { eventIntent: 'promote', externalTicketUrl: 'http://example.com/tickets' });
  expect(httpOnly.status).toBe(400);

  const notAUrl = await addFreeEvent(organiser, { eventIntent: 'promote', externalTicketUrl: 'just some text' });
  expect(notAUrl.status).toBe(400);

  const ok = await addFreeEvent(organiser, { eventIntent: 'promote', externalTicketUrl: 'https://example.com/tickets' });
  expect(ok.status).toBe(201);
});
