// RSVP question types and the answer wall - see featureplans/events-rsvp-question-types.md.
// The server is the source of truth: finalizeRegistrationFields cleans/validates the organiser's
// questions on save (types, caps, unique names, multiple-choice blocking, paid strip), and
// validateRegistrationAnswers walls the registration path (required + shape + blocking).
import Event from '../../models/eventModel.js';
import FreeTicket from '../../models/freeTicket.js';
import {
  createOrganiser,
  createUser,
  createFreeEvent,
  createPaidEvent,
  createFreeRegistration,
} from '../helpers/factories.js';
import { addFree as postFree, updateFree as putFree, updatePaid as putPaid, registerFree } from '../helpers/eventRequests.js';

// The question-focused shapes of the shared builders.
const addFree = (organiser, registrationFields) => postFree(organiser, { registrationFields });
const updateFree = (organiser, eventId, registrationFields) => putFree(organiser, eventId, { registrationFields });
const updatePaid = (organiser, eventId, registrationFields) => putPaid(organiser, eventId, { registrationFields });
const register = (user, event, formResponses) => registerFree(event, user, { formResponses });

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

test('a free event saves one valid question of each of the eight types', async () => {
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

test('a paid event only takes text and dropdown questions', async () => {
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

test('a question label over 200 characters or an option over 150 is rejected', async () => {
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

test('a dropdown, multiple-choice or checkboxes question needs at least two options', async () => {
  const org = await createOrganiser();
  for (const fieldType of ['select', 'radio', 'checkboxes']) {
    const r = await addFree(org, [{ fieldName: 'Pick one', fieldType, fieldOptions: ['Only'] }]);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/at least 2 options/i);
  }
  const ok = await addFree(org, [{ fieldName: 'Pick one', fieldType: 'select', fieldOptions: ['A', 'B'] }]);
  expect(ok.status).toBeLessThan(400);
});

test('two questions with the same name (ignoring case and spaces) are rejected', async () => {
  const org = await createOrganiser();
  const res = await addFree(org, [
    { fieldName: 'Meal choice', fieldType: 'text' },
    { fieldName: '  meal CHOICE  ', fieldType: 'text' },
  ]);
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/unique/i);
});

test('a blocking multiple-choice question is saved as required, keeping only blocking values that are real options', async () => {
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

test('a question where every option blocks registration is rejected', async () => {
  const org = await createOrganiser();
  const res = await addFree(org, [{
    fieldName: 'Impossible', fieldType: 'radio', fieldOptions: ['Yes', 'No'], blockingOptions: ['Yes', 'No'],
  }]);
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/blocks every answer|allows registration/i);
});

test('picking a blocking multiple-choice answer, or skipping it, refuses the RSVP with the organiser\'s message', async () => {
  const org = await createOrganiser();
  const event = await createFreeEvent(org, {
    registrationFields: [{
      fieldName: 'Are you 18 or over?', fieldType: 'radio', fieldOptions: ['Yes', 'No'],
      blockingOptions: ['No'], blockingMessage: 'Sorry, 18+ only.', isRequired: true,
    }],
  });
  const m1 = await createUser({ email: 'qt-7a@test.dev' });
  const blocked = await register(m1, event, [{ fieldName: 'Are you 18 or over?', response: 'No' }]);
  expect(blocked.status).toBe(400);
  expect(blocked.body.message).toBe('Sorry, 18+ only.');

  const m2 = await createUser({ email: 'qt-7b@test.dev' });
  const missing = await register(m2, event, []);
  expect(missing.status).toBe(400);
  expect(missing.body.message).toBe('Sorry, 18+ only.');
});

test('a missing required answer of any type refuses the RSVP', async () => {
  const org = await createOrganiser();
  const event = await createFreeEvent(org, {
    registrationFields: [{ fieldName: 'Rate us', fieldType: 'scale', isRequired: true }],
  });
  const member = await createUser({ email: 'qt-8@test.dev' });
  const res = await register(member, event, []);
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/required/i);
});

test('an unticked required yes/no refuses the RSVP; an unticked optional one saves as "No"', async () => {
  const org = await createOrganiser();

  const reqEvent = await createFreeEvent(org, {
    registrationFields: [{ fieldName: 'Agree to terms', fieldType: 'yesno', isRequired: true }],
  });
  const m1 = await createUser({ email: 'qt-9a@test.dev' });
  const refused = await register(m1, reqEvent, []);
  expect(refused.status).toBe(400);

  const optEvent = await createFreeEvent(org, {
    registrationFields: [{ fieldName: 'Subscribe?', fieldType: 'yesno', isRequired: false }],
  });
  const m2 = await createUser({ email: 'qt-9b@test.dev' });
  const ok = await register(m2, optEvent, []);
  expect(ok.status).toBeLessThan(400);
  const saved = await FreeTicket.findOne({ event: optEvent._id, user: m2._id });
  const ans = saved.formResponses.find((r) => r.fieldName === 'Subscribe?');
  expect(ans.response).toBe('No');
});

test('a pick-many answer saves the chosen values; an unknown value or an empty required answer is refused', async () => {
  const org = await createOrganiser();
  const event = await createFreeEvent(org, {
    registrationFields: [{ fieldName: 'Workshops', fieldType: 'checkboxes', fieldOptions: ['A', 'B', 'C'], isRequired: false }],
  });
  const m1 = await createUser({ email: 'qt-10a@test.dev' });
  const ok = await register(m1, event, [{ fieldName: 'Workshops', response: ['A', 'C'] }]);
  expect(ok.status).toBeLessThan(400);
  const saved = await FreeTicket.findOne({ event: event._id, user: m1._id });
  expect([...saved.formResponses.find((r) => r.fieldName === 'Workshops').response]).toEqual(['A', 'C']);

  const m2 = await createUser({ email: 'qt-10b@test.dev' });
  const badValue = await register(m2, event, [{ fieldName: 'Workshops', response: ['A', 'Z'] }]);
  expect(badValue.status).toBe(400);

  const reqEvent = await createFreeEvent(org, {
    registrationFields: [{ fieldName: 'Workshops', fieldType: 'checkboxes', fieldOptions: ['A', 'B'], isRequired: true }],
  });
  const m3 = await createUser({ email: 'qt-10c@test.dev' });
  const emptyReq = await register(m3, reqEvent, [{ fieldName: 'Workshops', response: [] }]);
  expect(emptyReq.status).toBe(400);
});

test('an answer that does not fit its question type is refused', async () => {
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
    const member = await createUser({ email: `qt-11-${i}@test.dev` });
    const res = await register(member, event, cases[i]);
    expect(res.status).toBe(400);
  }
});

// Note: post-activity EDITING of a free question's label-safe parts is allowed and is covered in
// tests/rsvp/question-editing.test.js. What stays locked once there are answers is the
// meaning-changing set: deleting a question or changing its type.
test('once people have answered, a question cannot be deleted or retyped, but new questions can be added', async () => {
  const org = await createOrganiser();
  // Seed with a stable qid so the id-anchored lock matches this question across the update.
  const scaleQ = { qid: 'q-rate-1', fieldName: 'Rate us', fieldType: 'scale', fieldOptions: [], isRequired: false, blockingOptions: [], blockingMessage: '' };
  const event = await createFreeEvent(org, { hasActivity: true, registrationFields: [scaleQ] });
  const member = await createUser({ email: 'qt-12@test.dev' });
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

test('a paid event never stores blocking answers on a dropdown', async () => {
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

test('a date question with "also ask time" needs a date and time answer, the setting is dropped from other types, and it locks once answered', async () => {
  const org = await createOrganiser();

  // A date + time question accepts the combined value and rejects a bare date.
  const dtEvent = await createFreeEvent(org, {
    registrationFields: [{ fieldName: 'When can you arrive', fieldType: 'date', includeTime: true, isRequired: true }],
  });
  const m1 = await createUser({ email: 'qt-18a@test.dev' });
  const combined = await register(m1, dtEvent, [{ fieldName: 'When can you arrive', response: '2027-01-02T14:30' }]);
  expect(combined.status).toBeLessThan(400);
  const m2 = await createUser({ email: 'qt-18b@test.dev' });
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
  const member = await createUser({ email: 'qt-18c@test.dev' });
  await createFreeRegistration(lockedEvent, member);
  const flip = await updateFree(org, lockedEvent._id, [{ ...dateQ, includeTime: true }]);
  expect(flip.status).toBe(409);
  expect(flip.body.code).toBe('EDIT_LOCKED');
});

test('scale labels save by position, cap at 15 characters, save as empty when all blank, and skip the choice rules', async () => {
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
