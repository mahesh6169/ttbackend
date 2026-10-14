// Blocking answers on free-RSVP dropdown questions - see featureplans/events-rsvp-blocking-questions.md.
// The server is the source of truth: it normalises the organiser's config on create/update (dropdown
// only, drop invalid values, force required, reject all-blocked) and walls the registration path.
import request from 'supertest';
import app from '../app.js';
import Event from '../models/eventModel.js';
import FreeTicket from '../models/freeTicket.js';
import { createOrganiser, createUser, createFreeEvent, cookieFor, API_KEY } from './helpers/factories.js';
import { DEFAULT_BLOCK_MESSAGE } from '../utils/constants/registrationMessages.js';

const FUTURE = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const ADDRESS = JSON.stringify({
  formattedAddress: '1 Test St, Sydney NSW 2000',
  suburb: 'Sydney', state: 'NSW',
  location: { type: 'Point', coordinates: [151.2093, -33.8688] },
});

const register = (user, event, formResponses) =>
  request(app)
    .post(`/api/events/${event._id}/free/register`)
    .set('Cookie', cookieFor(user)).set('x-api-key', API_KEY)
    .send({ mobile: '0412345678', attendees: [{ name: 'Attendee' }], formResponses });

// POST the real add-free-event endpoint (multipart), used for the server-config ACs (AC7/AC8).
const addFree = (organiser, registrationFields) =>
  request(app)
    .post('/api/events/add-free-event')
    .set('Cookie', cookieFor(organiser)).set('x-api-key', API_KEY)
    .field('title', 'Blocking Free Event')
    .field('dateTime', FUTURE())
    .field('venue', 'Test Hall')
    .field('description', 'A seeded free event for blocking tests.')
    .field('category', 'Community')
    .field('address', ADDRESS)
    .field('organizer', JSON.stringify({ name: 'Org', contact: '0412345678' }))
    .field('isPaid', 'false')
    .field('eventIntent', 'host')
    .field('capacity', '100')
    .field('maxAttendeesPerRegistration', '5')
    .field('registrationFields', JSON.stringify(registrationFields));

const ageQuestion = (overrides = {}) => ({
  fieldName: 'Are you 18 or over?',
  fieldType: 'select',
  fieldOptions: ['Yes', 'No'],
  blockingOptions: ['No'],
  isRequired: true,
  ...overrides,
});

// --- Registration wall (AC1-6, AC9, AC10) ---

test('AC1 answering a blocking option is rejected with the organiser custom message', async () => {
  const org = await createOrganiser();
  const member = await createUser({ email: 'ac1@test.dev' });
  const event = await createFreeEvent(org, {
    registrationFields: [ageQuestion({ blockingMessage: 'Sorry, this event is 18+ only.' })],
  });
  const res = await register(member, event, [{ fieldName: 'Are you 18 or over?', response: 'No' }]);
  expect(res.status).toBe(400);
  expect(res.body.message).toBe('Sorry, this event is 18+ only.');
});

test('AC2 a blank message falls back to the exact default string', async () => {
  const org = await createOrganiser();
  const member = await createUser({ email: 'ac2@test.dev' });
  const event = await createFreeEvent(org, { registrationFields: [ageQuestion({ blockingMessage: '' })] });
  const res = await register(member, event, [{ fieldName: 'Are you 18 or over?', response: 'No' }]);
  expect(res.status).toBe(400);
  expect(res.body.message).toBe(DEFAULT_BLOCK_MESSAGE);
  expect(res.body.message).toBe("Based on your answer, you're not able to register for this event.");
});

test('AC3 omitting/emptying a blocking question is rejected (it is required)', async () => {
  const org = await createOrganiser();
  const event = await createFreeEvent(org, { registrationFields: [ageQuestion()] });

  const m1 = await createUser({ email: 'ac3a@test.dev' });
  expect((await register(m1, event, [])).status).toBe(400); // omitted

  const m2 = await createUser({ email: 'ac3b@test.dev' });
  expect((await register(m2, event, [{ fieldName: 'Are you 18 or over?', response: '' }])).status).toBe(400); // empty
});

test('AC4 answering the non-blocking option succeeds and creates the registration', async () => {
  const org = await createOrganiser();
  const member = await createUser({ email: 'ac4@test.dev' });
  const event = await createFreeEvent(org, { registrationFields: [ageQuestion()] });
  const res = await register(member, event, [{ fieldName: 'Are you 18 or over?', response: 'Yes' }]);
  expect(res.status).toBeLessThan(400);
  expect(res.body.success).toBe(true);
  expect(await FreeTicket.countDocuments({ event: event._id })).toBe(1);
});

test('AC5 blocking is scoped per question, not global by value', async () => {
  const org = await createOrganiser();
  const member = await createUser({ email: 'ac5@test.dev' });
  const event = await createFreeEvent(org, {
    registrationFields: [
      ageQuestion(), // "No" blocks
      { fieldName: 'Join the newsletter?', fieldType: 'select', fieldOptions: ['Yes', 'No'], blockingOptions: [], isRequired: false },
    ],
  });
  // "No" on the NON-blocking newsletter question is fine; safe answer on the blocking one.
  const res = await register(member, event, [
    { fieldName: 'Are you 18 or over?', response: 'Yes' },
    { fieldName: 'Join the newsletter?', response: 'No' },
  ]);
  expect(res.status).toBeLessThan(400);
  expect(res.body.success).toBe(true);
});

test('AC6 the block matches the exact stored option value (survives a rename)', async () => {
  const org = await createOrganiser();
  const member = await createUser({ email: 'ac6@test.dev' });
  // The organiser renamed the option; the stored blocking value is the new label.
  const event = await createFreeEvent(org, {
    registrationFields: [{
      fieldName: 'Age bracket', fieldType: 'select',
      fieldOptions: ['Under 18', '18 or over'], blockingOptions: ['Under 18'], isRequired: true,
    }],
  });
  const res = await register(member, event, [{ fieldName: 'Age bracket', response: 'Under 18' }]);
  expect(res.status).toBe(400);
});

test('AC9 a guest is rejected identically to a member', async () => {
  const org = await createOrganiser();
  const guest = await createUser({ role: 'guest', email: 'ac9-guest@test.dev' });
  const event = await createFreeEvent(org, { registrationFields: [ageQuestion({ blockingMessage: 'No entry.' })] });
  const res = await register(guest, event, [{ fieldName: 'Are you 18 or over?', response: 'No' }]);
  expect(res.status).toBe(400);
  expect(res.body.message).toBe('No entry.');
});

test('AC10 an event with no blocking registers exactly as before (regression)', async () => {
  const org = await createOrganiser();
  const member = await createUser({ email: 'ac10@test.dev' });
  const event = await createFreeEvent(org, {
    registrationFields: [{ fieldName: 'Dietary needs', fieldType: 'text', isRequired: false }],
  });
  const res = await register(member, event, [{ fieldName: 'Dietary needs', response: 'None' }]);
  expect(res.status).toBeLessThan(400);
  expect(res.body.success).toBe(true);
});

// --- Server config validation (AC7, AC8) ---

test('AC7 creating a free event whose question blocks every option is rejected', async () => {
  const org = await createOrganiser();
  const res = await addFree(org, [{
    fieldName: 'Impossible', fieldType: 'select', fieldOptions: ['Yes', 'No'], blockingOptions: ['Yes', 'No'],
  }]);
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/blocks every answer|allows registration/i);
});

test('AC8 a blocking option coerces the question to required, even if the client omits the flag', async () => {
  const org = await createOrganiser();
  const res = await addFree(org, [{
    fieldName: 'Are you 18 or over?', fieldType: 'select', fieldOptions: ['Yes', 'No'],
    blockingOptions: ['No'], isRequired: false, // client says not required...
  }]);
  expect(res.status).toBeLessThan(400);
  const created = await Event.findById(res.body.event?._id || res.body.event);
  const q = created.registrationFields.find((f) => f.fieldName === 'Are you 18 or over?');
  expect(q.isRequired).toBe(true); // ...server coerced it to required
  expect([...q.blockingOptions]).toEqual(['No']);
});
