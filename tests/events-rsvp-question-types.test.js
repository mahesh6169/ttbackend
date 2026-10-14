// featureplans/events-rsvp-question-types.md - RSVP question types + answer wall (AC1-13, AC18-19).
// The server is the source of truth: finalizeRegistrationFields cleans/validates the organiser's
// questions on save (types, caps, unique names, multiple-choice blocking, paid strip), and
// validateRegistrationAnswers walls the registration path (required + shape + blocking).
import request from 'supertest';
import app from '../app.js';
import Event from '../models/eventModel.js';
import FreeTicket from '../models/freeTicket.js';
import {
  createOrganiser,
  createUser,
  createFreeEvent,
  createPaidEvent,
  createFreeRegistration,
  cookieFor,
  API_KEY,
} from './helpers/factories.js';

const FUTURE = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const ADDRESS = JSON.stringify({
  formattedAddress: '1 Test St, Sydney NSW 2000',
  suburb: 'Sydney', state: 'NSW',
  location: { type: 'Point', coordinates: [151.2093, -33.8688] },
});

// POST the real add-free-event endpoint (multipart, like the wizard).
const addFree = (organiser, registrationFields) =>
  request(app)
    .post('/api/events/add-free-event')
    .set('Cookie', cookieFor(organiser)).set('x-api-key', API_KEY)
    .field('title', 'Question Types Free Event')
    .field('dateTime', FUTURE())
    .field('venue', 'Test Hall')
    .field('description', 'A seeded free event for question-type tests.')
    .field('category', 'Community')
    .field('address', ADDRESS)
    .field('organizer', JSON.stringify({ name: 'Org', contact: '0412345678' }))
    .field('isPaid', 'false')
    .field('eventIntent', 'host')
    .field('capacity', '100')
    .field('maxAttendeesPerRegistration', '5')
    .field('registrationFields', JSON.stringify(registrationFields));

// PUT the real update-free endpoint (multipart, like the wizard).
const updateFree = (organiser, eventId, registrationFields) =>
  request(app)
    .put(`/api/events/update-free/${eventId}`)
    .set('Cookie', cookieFor(organiser)).set('x-api-key', API_KEY)
    .field('title', 'Question Types Free Event')
    .field('dateTime', FUTURE())
    .field('venue', 'Test Hall')
    .field('description', 'A seeded free event for question-type tests.')
    .field('category', 'Community')
    .field('address', ADDRESS)
    .field('organizer', JSON.stringify({ name: 'Org', contact: '0412345678' }))
    .field('isPaid', 'false')
    .field('eventIntent', 'host')
    .field('capacity', '100')
    .field('maxAttendeesPerRegistration', '5')
    .field('registrationFields', JSON.stringify(registrationFields));

// PUT the real update-paid endpoint (multipart, like the wizard).
const updatePaid = (organiser, eventId, registrationFields, ticketTypes = [{ name: 'Standard', price: 10 }]) =>
  request(app)
    .put(`/api/events/update-paid/${eventId}`)
    .set('Cookie', cookieFor(organiser)).set('x-api-key', API_KEY)
    .field('title', 'Question Types Paid Event')
    .field('dateTime', FUTURE())
    .field('venue', 'Test Hall')
    .field('description', 'A seeded paid event for question-type tests.')
    .field('category', 'Community')
    .field('address', ADDRESS)
    .field('organizer', JSON.stringify({ name: 'Org', contact: '0412345678' }))
    .field('ticketTypes', JSON.stringify(ticketTypes))
    .field('capacity', '100')
    .field('maxAttendeesPerRegistration', '10')
    .field('seatingLayout', JSON.stringify([]))
    .field('registrationFields', JSON.stringify(registrationFields));

const register = (user, event, formResponses) =>
  request(app)
    .post(`/api/events/${event._id}/free/register`)
    .set('Cookie', cookieFor(user)).set('x-api-key', API_KEY)
    .send({ mobile: '0412345678', attendees: [{ name: 'Attendee' }], formResponses });

// One valid question of each of the eight types.
const oneOfEach = () => [
  { fieldName: 'Dietary needs', fieldType: 'text', isRequired: false },
  { fieldName: 'T-shirt size', fieldType: 'select', fieldOptions: ['S', 'M', 'L'], isRequired: true },
  { fieldName: 'Meal choice', fieldType: 'radio', fieldOptions: ['Veg', 'Non-veg'], isRequired: true },
  { fieldName: 'Workshops', fieldType: 'checkboxes', fieldOptions: ['A', 'B', 'C'], isRequired: false },
  { fieldName: 'Rate the venue', fieldType: 'scale', isRequired: false },
  { fieldName: 'Arrival date', fieldType: 'date', isRequired: false },
  { fieldName: 'Arrival time', fieldType: 'time', isRequired: false },
  { fieldName: 'Agree to code of conduct', fieldType: 'yesno', isRequired: true },
];

// --- AC1: all eight types persist ---
test('AC1 a free event with one valid question of each of the eight types persists correctly', async () => {
  const org = await createOrganiser();
  const res = await addFree(org, oneOfEach());
  expect(res.status).toBe(201);
  const created = await Event.findById(res.body.event._id);
  const byName = Object.fromEntries(created.registrationFields.map((f) => [f.fieldName, f]));
  expect(created.registrationFields).toHaveLength(8);
  expect(byName['T-shirt size'].fieldType).toBe('select');
  expect([...byName['T-shirt size'].fieldOptions]).toEqual(['S', 'M', 'L']);
  expect(byName['T-shirt size'].isRequired).toBe(true);
  expect(byName['Meal choice'].fieldType).toBe('radio');
  expect([...byName['Workshops'].fieldOptions]).toEqual(['A', 'B', 'C']);
  expect(byName['Rate the venue'].fieldType).toBe('scale');
  expect(byName['Agree to code of conduct'].fieldType).toBe('yesno');
  expect(byName['Agree to code of conduct'].isRequired).toBe(true);
});

// --- AC2: paid rejects new types; text+dropdown saves ---
test('AC2 a paid save with a new-type question is rejected; text + dropdown saves', async () => {
  const org = await createOrganiser();
  const event = await createPaidEvent(org);

  const bad = await updatePaid(org, event._id, [
    { fieldName: 'Meal choice', fieldType: 'radio', fieldOptions: ['Veg', 'Non-veg'] },
  ]);
  expect(bad.status).toBe(400);
  expect(bad.body.message).toMatch(/only text and dropdown/i);

  const ok = await updatePaid(org, event._id, [
    { fieldName: 'Notes', fieldType: 'text', isRequired: false },
    { fieldName: 'Size', fieldType: 'select', fieldOptions: ['S', 'M'], isRequired: false },
  ]);
  expect(ok.status).toBeLessThan(400);
  const saved = await Event.findById(event._id);
  expect(saved.registrationFields.map((f) => f.fieldType).sort()).toEqual(['select', 'text']);
});

// --- AC3: caps ---
test('AC3 a label over 200 chars or an option over 150 chars is rejected', async () => {
  const org = await createOrganiser();
  const longLabel = 'x'.repeat(201);
  const r1 = await addFree(org, [{ fieldName: longLabel, fieldType: 'text' }]);
  expect(r1.status).toBe(400);
  expect(r1.body.message).toMatch(/200 characters/i);

  const longOption = 'y'.repeat(151);
  const r2 = await addFree(org, [{ fieldName: 'Pick one', fieldType: 'select', fieldOptions: [longOption, 'ok'] }]);
  expect(r2.status).toBe(400);
  expect(r2.body.message).toMatch(/150 characters/i);
});

test('a dropdown, multiple-choice, or checkboxes question needs at least two options', async () => {
  const org = await createOrganiser();
  for (const fieldType of ['select', 'radio', 'checkboxes']) {
    const r = await addFree(org, [{ fieldName: 'Pick one', fieldType, fieldOptions: ['Only'] }]);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/at least 2 options/i);
  }
  const ok = await addFree(org, [{ fieldName: 'Pick one', fieldType: 'select', fieldOptions: ['A', 'B'] }]);
  expect(ok.status).toBeLessThan(400);
});

// --- AC4: unique names (case + space insensitive) ---
test('AC4 two questions whose names match ignoring case and spaces are rejected', async () => {
  const org = await createOrganiser();
  const res = await addFree(org, [
    { fieldName: 'Meal choice', fieldType: 'text' },
    { fieldName: '  meal CHOICE  ', fieldType: 'text' },
  ]);
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/unique/i);
});

// --- AC5: MC blocking normalisation ---
test('AC5 a multiple-choice blocking option stores required, dropping values not in the options', async () => {
  const org = await createOrganiser();
  const res = await addFree(org, [{
    fieldName: 'Are you 18 or over?', fieldType: 'radio',
    fieldOptions: ['Yes', 'No'], blockingOptions: ['No', 'Maybe'], isRequired: false,
  }]);
  expect(res.status).toBe(201);
  const created = await Event.findById(res.body.event._id);
  const q = created.registrationFields.find((f) => f.fieldName === 'Are you 18 or over?');
  expect(q.isRequired).toBe(true);
  expect([...q.blockingOptions]).toEqual(['No']); // 'Maybe' dropped (not an option)
});

// --- AC6: MC blocks every option ---
test('AC6 a multiple-choice question whose every option blocks is rejected', async () => {
  const org = await createOrganiser();
  const res = await addFree(org, [{
    fieldName: 'Impossible', fieldType: 'radio', fieldOptions: ['Yes', 'No'], blockingOptions: ['Yes', 'No'],
  }]);
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/blocks every answer|allows registration/i);
});

// --- AC7: blocking MC at registration ---
test('AC7 answering a blocking multiple-choice option, or leaving it unanswered, is refused with the message', async () => {
  const org = await createOrganiser();
  const event = await createFreeEvent(org, {
    registrationFields: [{
      fieldName: 'Are you 18 or over?', fieldType: 'radio', fieldOptions: ['Yes', 'No'],
      blockingOptions: ['No'], blockingMessage: 'Sorry, 18+ only.', isRequired: true,
    }],
  });
  const m1 = await createUser({ email: 'qt-ac7a@test.dev' });
  const blocked = await register(m1, event, [{ fieldName: 'Are you 18 or over?', response: 'No' }]);
  expect(blocked.status).toBe(400);
  expect(blocked.body.message).toBe('Sorry, 18+ only.');

  const m2 = await createUser({ email: 'qt-ac7b@test.dev' });
  const missing = await register(m2, event, []);
  expect(missing.status).toBe(400);
  expect(missing.body.message).toBe('Sorry, 18+ only.');
});

// --- AC8: required of any type ---
test('AC8 a missing required answer of any type is refused by the server', async () => {
  const org = await createOrganiser();
  const event = await createFreeEvent(org, {
    registrationFields: [{ fieldName: 'Rate us', fieldType: 'scale', isRequired: true }],
  });
  const member = await createUser({ email: 'qt-ac8@test.dev' });
  const res = await register(member, event, []);
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/required/i);
});

// --- AC9: yes/no semantics ---
test('AC9 a required yes/no unticked is refused; an optional yes/no unticked saves as "No"', async () => {
  const org = await createOrganiser();

  const reqEvent = await createFreeEvent(org, {
    registrationFields: [{ fieldName: 'Agree to terms', fieldType: 'yesno', isRequired: true }],
  });
  const m1 = await createUser({ email: 'qt-ac9a@test.dev' });
  const refused = await register(m1, reqEvent, []);
  expect(refused.status).toBe(400);

  const optEvent = await createFreeEvent(org, {
    registrationFields: [{ fieldName: 'Subscribe?', fieldType: 'yesno', isRequired: false }],
  });
  const m2 = await createUser({ email: 'qt-ac9b@test.dev' });
  const ok = await register(m2, optEvent, []);
  expect(ok.status).toBeLessThan(400);
  const saved = await FreeTicket.findOne({ event: optEvent._id, user: m2._id });
  const ans = saved.formResponses.find((r) => r.fieldName === 'Subscribe?');
  expect(ans.response).toBe('No');
});

// --- AC10: pick-many ---
test('AC10 pick-many stores chosen values; an out-of-list value or empty required is refused', async () => {
  const org = await createOrganiser();
  const event = await createFreeEvent(org, {
    registrationFields: [{ fieldName: 'Workshops', fieldType: 'checkboxes', fieldOptions: ['A', 'B', 'C'], isRequired: false }],
  });
  const m1 = await createUser({ email: 'qt-ac10a@test.dev' });
  const ok = await register(m1, event, [{ fieldName: 'Workshops', response: ['A', 'C'] }]);
  expect(ok.status).toBeLessThan(400);
  const saved = await FreeTicket.findOne({ event: event._id, user: m1._id });
  expect([...saved.formResponses.find((r) => r.fieldName === 'Workshops').response]).toEqual(['A', 'C']);

  const m2 = await createUser({ email: 'qt-ac10b@test.dev' });
  const badValue = await register(m2, event, [{ fieldName: 'Workshops', response: ['A', 'Z'] }]);
  expect(badValue.status).toBe(400);

  const reqEvent = await createFreeEvent(org, {
    registrationFields: [{ fieldName: 'Workshops', fieldType: 'checkboxes', fieldOptions: ['A', 'B'], isRequired: true }],
  });
  const m3 = await createUser({ email: 'qt-ac10c@test.dev' });
  const emptyReq = await register(m3, reqEvent, [{ fieldName: 'Workshops', response: [] }]);
  expect(emptyReq.status).toBe(400);
});

// --- AC11: answer shapes ---
test('AC11 an answer breaking its question shape is refused', async () => {
  const org = await createOrganiser();
  const event = await createFreeEvent(org, {
    registrationFields: [
      { fieldName: 'Notes', fieldType: 'text', isRequired: false },
      { fieldName: 'Rating', fieldType: 'scale', isRequired: false },
      { fieldName: 'When', fieldType: 'date', isRequired: false },
      { fieldName: 'At', fieldType: 'time', isRequired: false },
      { fieldName: 'Size', fieldType: 'select', fieldOptions: ['S', 'M'], isRequired: false },
    ],
  });

  const longText = 'z'.repeat(501);
  const cases = [
    [{ fieldName: 'Notes', response: longText }],
    [{ fieldName: 'Rating', response: 9 }],
    [{ fieldName: 'When', response: 'not-a-date' }],
    [{ fieldName: 'At', response: '99:99' }],
    [{ fieldName: 'Size', response: 'XL' }],
  ];
  for (let i = 0; i < cases.length; i++) {
    const member = await createUser({ email: `qt-ac11-${i}@test.dev` });
    const res = await register(member, event, cases[i]);
    expect(res.status).toBe(400);
  }
});

// --- AC12: activity lock covers new types ---
// Note: post-activity EDITING of a free question's label-safe parts is now allowed and is owned by
// events-rsvp-question-editing.md (which reverses the old full freeze). What stays locked once there
// are answers is the meaning-changing set: deleting a question or changing its type.
test('AC12 with activity, deleting or retyping an existing question is locked; adding one passes', async () => {
  const org = await createOrganiser();
  // Seed with a stable qid so the id-anchored lock matches this question across the update.
  const scaleQ = { qid: 'q-rate-1', fieldName: 'Rate us', fieldType: 'scale', fieldOptions: [], isRequired: false, blockingOptions: [], blockingMessage: '' };
  const event = await createFreeEvent(org, { hasActivity: true, registrationFields: [scaleQ] });
  const member = await createUser({ email: 'qt-ac12@test.dev' });
  await createFreeRegistration(event, member);

  // Deleting the question is rejected.
  const deleted = await updateFree(org, event._id, []);
  expect(deleted.status).toBe(409);
  expect(deleted.body.code).toBe('EDIT_LOCKED');

  // Changing its type is rejected.
  const retyped = await updateFree(org, event._id, [{ ...scaleQ, fieldType: 'text', fieldOptions: [] }]);
  expect(retyped.status).toBe(409);

  // Keeping it and adding a new question passes.
  const added = await updateFree(org, event._id, [
    scaleQ,
    { fieldName: 'New question', fieldType: 'text', isRequired: false },
  ]);
  expect(added.status).toBeLessThan(400);
  const saved = await Event.findById(event._id);
  expect(saved.registrationFields).toHaveLength(2);
});

// --- AC13: paid strips blocking ---
test('AC13 a paid save carrying blocking on a dropdown stores no blocking config', async () => {
  const org = await createOrganiser();
  const event = await createPaidEvent(org);
  const res = await updatePaid(org, event._id, [{
    fieldName: 'Meal', fieldType: 'select', fieldOptions: ['Veg', 'Non-veg'],
    blockingOptions: ['Non-veg'], blockingMessage: 'blocked', isRequired: true,
  }]);
  expect(res.status).toBeLessThan(400);
  const saved = await Event.findById(event._id);
  const q = saved.registrationFields.find((f) => f.fieldName === 'Meal');
  expect(q.blockingOptions?.length || 0).toBe(0);
  expect(q.blockingMessage || '').toBe('');
});

// --- AC18: date "Also ask time" (includeTime) ---
test('AC18 a date question with "Also ask time" takes a combined answer, strips includeTime elsewhere, and locks it', async () => {
  const org = await createOrganiser();

  // A date + time question accepts the combined value and rejects a bare date.
  const dtEvent = await createFreeEvent(org, {
    registrationFields: [{ fieldName: 'When can you arrive', fieldType: 'date', includeTime: true, isRequired: true }],
  });
  const m1 = await createUser({ email: 'qt-ac18a@test.dev' });
  const combined = await register(m1, dtEvent, [{ fieldName: 'When can you arrive', response: '2027-01-02T14:30' }]);
  expect(combined.status).toBeLessThan(400);
  const m2 = await createUser({ email: 'qt-ac18b@test.dev' });
  const bare = await register(m2, dtEvent, [{ fieldName: 'When can you arrive', response: '2027-01-02' }]);
  expect(bare.status).toBe(400);

  // includeTime is stripped from every non-date type on save.
  const stripRes = await addFree(org, [{ fieldName: 'Notes', fieldType: 'text', includeTime: true }]);
  expect(stripRes.status).toBe(201);
  const stripped = await Event.findById(stripRes.body.event._id);
  expect(stripped.registrationFields[0].includeTime).toBe(false);

  // includeTime is part of the lock signature: flipping it on an existing question with activity is refused.
  const dateQ = { fieldName: 'Arrival', fieldType: 'date', fieldOptions: [], isRequired: false, includeTime: false, blockingOptions: [], blockingMessage: '' };
  const lockedEvent = await createFreeEvent(org, { hasActivity: true, registrationFields: [dateQ] });
  const member = await createUser({ email: 'qt-ac18c@test.dev' });
  await createFreeRegistration(lockedEvent, member);
  const flip = await updateFree(org, lockedEvent._id, [{ ...dateQ, includeTime: true }]);
  expect(flip.status).toBe(409);
  expect(flip.body.code).toBe('EDIT_LOCKED');
});

// --- AC19: scale labels ---
test('AC19 scale labels save positionally, cap at 15 chars, store [] when all-empty, and skip choice rules', async () => {
  const org = await createOrganiser();

  // Up to five positional labels save with the question (empties preserved between filled slots).
  const labelled = await addFree(org, [{ fieldName: 'Rate us', fieldType: 'scale', fieldOptions: ['Poor', '', '', '', 'Great'] }]);
  expect(labelled.status).toBe(201);
  const saved = await Event.findById(labelled.body.event._id);
  expect([...saved.registrationFields[0].fieldOptions]).toEqual(['Poor', '', '', '', 'Great']);

  // A label over 15 characters is rejected.
  const tooLong = await addFree(org, [{ fieldName: 'Rate', fieldType: 'scale', fieldOptions: ['x'.repeat(16)] }]);
  expect(tooLong.status).toBe(400);

  // All-empty labels store as an empty list.
  const empty = await addFree(org, [{ fieldName: 'Rate blank', fieldType: 'scale', fieldOptions: ['', '', '', '', ''] }]);
  expect(empty.status).toBe(201);
  const savedEmpty = await Event.findById(empty.body.event._id);
  expect(savedEmpty.registrationFields[0].fieldOptions.length).toBe(0);

  // Scale is exempt from the choice-type option rules (duplicates / empties are fine, not rejected).
  const dupes = await addFree(org, [{ fieldName: 'Rate dupes', fieldType: 'scale', fieldOptions: ['Same', 'Same', '', '', ''] }]);
  expect(dupes.status).toBe(201);
  const savedDupes = await Event.findById(dupes.body.event._id);
  expect([...savedDupes.registrationFields[0].fieldOptions]).toEqual(['Same', 'Same', '', '', '']);
});
