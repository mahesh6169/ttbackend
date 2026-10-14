// featureplans/events-rsvp-question-editing.md - stable question ids + post-activity editing (AC1-9).
// Every question carries a stable qid preserved across saves; answers link by qid (text kept); free
// events allow label-safe edits after activity while meaning-changing edits stay locked; paid stays
// fully frozen; displays/CSV match answers by id first, name fallback.
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
import { matchAnswerToQuestion, stampAnswerIds } from '../utils/events/answerMatching.js';

const FUTURE = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const ADDRESS = JSON.stringify({
  formattedAddress: '1 Test St, Sydney NSW 2000',
  suburb: 'Sydney', state: 'NSW',
  location: { type: 'Point', coordinates: [151.2093, -33.8688] },
});

const addFree = (organiser, registrationFields) =>
  request(app)
    .post('/api/events/add-free-event')
    .set('Cookie', cookieFor(organiser)).set('x-api-key', API_KEY)
    .field('title', 'Question Editing Free Event')
    .field('dateTime', FUTURE())
    .field('venue', 'Test Hall')
    .field('description', 'A seeded free event for question-editing tests.')
    .field('category', 'Community')
    .field('address', ADDRESS)
    .field('organizer', JSON.stringify({ name: 'Org', contact: '0412345678' }))
    .field('isPaid', 'false')
    .field('eventIntent', 'host')
    .field('capacity', '100')
    .field('maxAttendeesPerRegistration', '5')
    .field('registrationFields', JSON.stringify(registrationFields));

const updateFree = (organiser, eventId, registrationFields) =>
  request(app)
    .put(`/api/events/update-free/${eventId}`)
    .set('Cookie', cookieFor(organiser)).set('x-api-key', API_KEY)
    .field('title', 'Question Editing Free Event')
    .field('dateTime', FUTURE())
    .field('venue', 'Test Hall')
    .field('description', 'A seeded free event for question-editing tests.')
    .field('category', 'Community')
    .field('address', ADDRESS)
    .field('organizer', JSON.stringify({ name: 'Org', contact: '0412345678' }))
    .field('isPaid', 'false')
    .field('eventIntent', 'host')
    .field('capacity', '100')
    .field('maxAttendeesPerRegistration', '5')
    .field('registrationFields', JSON.stringify(registrationFields));

const updatePaid = (organiser, eventId, registrationFields, ticketTypes = [{ name: 'Standard', price: 10 }]) =>
  request(app)
    .put(`/api/events/update-paid/${eventId}`)
    .set('Cookie', cookieFor(organiser)).set('x-api-key', API_KEY)
    .field('title', 'Question Editing Paid Event')
    .field('dateTime', FUTURE())
    .field('venue', 'Test Hall')
    .field('description', 'A seeded paid event for question-editing tests.')
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

const getAttendees = (organiser, eventId) =>
  request(app)
    .get(`/api/events/${eventId}/free/attendees?limit=1000`)
    .set('Cookie', cookieFor(organiser)).set('x-api-key', API_KEY);

const fieldsOf = async (eventId) => (await Event.findById(eventId)).registrationFields;

// A finalized-shape free choice question (with a stable qid), for lock tests seeded via the factory.
const choiceQ = (over = {}) => ({
  qid: 'q-size', fieldName: 'T-shirt size', fieldType: 'select',
  fieldOptions: ['S', 'M', 'L'], isRequired: false, includeTime: false,
  blockingOptions: [], blockingMessage: '', ...over,
});

// --- AC1: ids stable across saves ---
test('AC1 questions keep the same id across two saves', async () => {
  const org = await createOrganiser();
  const created = await addFree(org, [{ fieldName: 'Dietary needs', fieldType: 'text', isRequired: false }]);
  expect(created.status).toBe(201);
  const q1 = (await fieldsOf(created.body.event._id))[0];
  expect(q1.qid).toBeTruthy();

  // Save again with the question round-tripped (qid included) - the id must not change.
  const updated = await updateFree(org, created.body.event._id, [
    { qid: q1.qid, fieldName: 'Dietary needs', fieldType: 'text', isRequired: false },
  ]);
  expect(updated.status).toBeLessThan(400);
  const q2 = (await fieldsOf(created.body.event._id))[0];
  expect(q2.qid).toBe(q1.qid);
});

// --- AC2: legacy (no id) gains one on save, keeps it ---
test('AC2 a question saved without an id gains one on save and keeps it', async () => {
  const org = await createOrganiser();
  // Seeded directly (bypasses the finalizer), so it has no qid - the pre-feature shape.
  const event = await createFreeEvent(org, {
    registrationFields: [{ fieldName: 'Diet', fieldType: 'text', isRequired: false }],
  });
  expect((await fieldsOf(event._id))[0].qid).toBeFalsy();

  const r1 = await updateFree(org, event._id, [{ fieldName: 'Diet', fieldType: 'text', isRequired: false }]);
  expect(r1.status).toBeLessThan(400);
  const minted = (await fieldsOf(event._id))[0].qid;
  expect(minted).toBeTruthy();

  const r2 = await updateFree(org, event._id, [{ qid: minted, fieldName: 'Diet', fieldType: 'text', isRequired: false }]);
  expect(r2.status).toBeLessThan(400);
  expect((await fieldsOf(event._id))[0].qid).toBe(minted);
});

// --- AC3: answers carry the id (free HTTP + paid stamping helper) ---
test('AC3 a stored answer carries the question id AND the question text (free + paid)', async () => {
  const org = await createOrganiser();
  const member = await createUser({ email: 'qe-ac3@test.dev' });
  const created = await addFree(org, [{ fieldName: 'T-shirt size', fieldType: 'select', fieldOptions: ['S', 'M'], isRequired: false }]);
  const qid = (await fieldsOf(created.body.event._id))[0].qid;

  const res = await register(member, { _id: created.body.event._id }, [{ fieldName: 'T-shirt size', response: 'M' }]);
  expect(res.status).toBeLessThan(400);
  const ticket = await FreeTicket.findOne({ event: created.body.event._id, user: member._id });
  const ans = ticket.formResponses[0];
  expect(ans.fieldName).toBe('T-shirt size'); // text kept
  expect(ans.qid).toBe(qid);                    // id linked

  // Paid checkout stamps ids with the same shared helper the confirm-payment path runs.
  const stamped = stampAnswerIds([{ fieldName: 'T-shirt size', response: 'L' }], [{ qid: 'p-1', fieldName: 'T-shirt size' }]);
  expect(stamped[0]).toEqual({ fieldName: 'T-shirt size', qid: 'p-1', response: 'L' });
});

// --- AC4: rename an answered free question ---
test('AC4 renaming an answered free-event question saves, keeps old answers, and re-labels on read', async () => {
  const org = await createOrganiser();
  const member = await createUser({ email: 'qe-ac4@test.dev' });
  const created = await addFree(org, [{ fieldName: 'Meal choice', fieldType: 'text', isRequired: false }]);
  const eventId = created.body.event._id;
  const qid = (await fieldsOf(eventId))[0].qid;

  await register(member, { _id: eventId }, [{ fieldName: 'Meal choice', response: 'Vegetarian' }]);

  // Rename (id unchanged) - allowed on a free event even with answers.
  const renamed = await updateFree(org, eventId, [{ qid, fieldName: 'Meal preference', fieldType: 'text', isRequired: false }]);
  expect(renamed.status).toBeLessThan(400);

  // The stored answer keeps the wording it was asked under (not rewritten).
  const ticket = await FreeTicket.findOne({ event: eventId, user: member._id });
  expect(ticket.formResponses[0].fieldName).toBe('Meal choice');

  // The attendees endpoint re-labels the answer to the CURRENT label by id.
  const list = await getAttendees(org, eventId);
  expect(list.status).toBe(200);
  const reg = list.body.registrations.find((r) => String(r.user?._id || r.user) === String(member._id)) || list.body.registrations[0];
  expect(reg.formResponses[0].fieldName).toBe('Meal preference');
  expect(reg.formResponses[0].response).toBe('Vegetarian');
});

// --- AC5: append vs remove/rename an option ---
test('AC5 appending an option to an answered choice question saves; removing or renaming one is rejected', async () => {
  const org = await createOrganiser();

  const eAppend = await createFreeEvent(org, { hasActivity: true, registrationFields: [choiceQ()] });
  const append = await updateFree(org, eAppend._id, [{ ...choiceQ(), fieldOptions: ['S', 'M', 'L', 'XL'] }]);
  expect(append.status).toBeLessThan(400);
  expect((await fieldsOf(eAppend._id))[0].fieldOptions).toEqual(['S', 'M', 'L', 'XL']);

  const eRemove = await createFreeEvent(org, { hasActivity: true, registrationFields: [choiceQ()] });
  const removed = await updateFree(org, eRemove._id, [{ ...choiceQ(), fieldOptions: ['S', 'M'] }]);
  expect(removed.status).toBe(409);

  const eRename = await createFreeEvent(org, { hasActivity: true, registrationFields: [choiceQ()] });
  const renamedOpt = await updateFree(org, eRename._id, [{ ...choiceQ(), fieldOptions: ['S', 'Medium', 'L'] }]);
  expect(renamedOpt.status).toBe(409);
});

// --- AC6: meaning-changing edits stay locked (free) ---
test('AC6 changing type, toggling includeTime, altering blocking, or deleting an answered question is rejected', async () => {
  const org = await createOrganiser();
  const dateQ = { qid: 'q-date', fieldName: 'Arrival', fieldType: 'date', fieldOptions: [], isRequired: false, includeTime: false, blockingOptions: [], blockingMessage: '' };
  const blockQ = { qid: 'q-age', fieldName: 'Are you 18 or over?', fieldType: 'select', fieldOptions: ['Yes', 'No'], isRequired: true, includeTime: false, blockingOptions: ['No'], blockingMessage: 'No entry.' };

  const eType = await createFreeEvent(org, { hasActivity: true, registrationFields: [choiceQ()] });
  expect((await updateFree(org, eType._id, [{ ...choiceQ(), fieldType: 'radio' }])).status).toBe(409);

  const eTime = await createFreeEvent(org, { hasActivity: true, registrationFields: [dateQ] });
  expect((await updateFree(org, eTime._id, [{ ...dateQ, includeTime: true }])).status).toBe(409);

  const eBlock = await createFreeEvent(org, { hasActivity: true, registrationFields: [blockQ] });
  expect((await updateFree(org, eBlock._id, [{ ...blockQ, blockingOptions: [] }])).status).toBe(409);

  const eDelete = await createFreeEvent(org, { hasActivity: true, registrationFields: [choiceQ()] });
  expect((await updateFree(org, eDelete._id, [])).status).toBe(409);
});

// --- AC7: paid keeps the full freeze ---
test('AC7 any edit to an answered PAID-event question is rejected, rename included', async () => {
  const org = await createOrganiser();
  const paidQ = { qid: 'q-notes', fieldName: 'Notes', fieldType: 'text', fieldOptions: [], isRequired: false, includeTime: false, blockingOptions: [], blockingMessage: '' };

  const eRename = await createPaidEvent(org, { hasActivity: true, registrationFields: [paidQ] });
  expect((await updatePaid(org, eRename._id, [{ ...paidQ, fieldName: 'Extra notes' }])).status).toBe(409);

  const eDrop = await createPaidEvent(org, { hasActivity: true, registrationFields: [{ ...paidQ, qid: 'q-sz', fieldName: 'Size', fieldType: 'select', fieldOptions: ['S', 'M'] }] });
  // Even an append (label-safe on FREE) is frozen on paid.
  expect((await updatePaid(org, eDrop._id, [{ qid: 'q-sz', fieldName: 'Size', fieldType: 'select', fieldOptions: ['S', 'M', 'L'], isRequired: false }])).status).toBe(409);
});

// --- AC8: mixed id / no-id answers all resolve ---
test('AC8 answers with and without ids on the same event both match their questions', async () => {
  const org = await createOrganiser();
  const q = choiceQ();
  const event = await createFreeEvent(org, { hasActivity: true, registrationFields: [q] });
  const m1 = await createUser({ email: 'qe-ac8a@test.dev' });
  const m2 = await createUser({ email: 'qe-ac8b@test.dev' });
  // One answer carries the id (new shape); one carries only the name (pre-feature shape).
  await createFreeRegistration(event, m1, { registrationNumber: 'RE-ID', formResponses: [{ fieldName: 'T-shirt size', qid: 'q-size', response: 'M' }] });
  await createFreeRegistration(event, m2, { registrationNumber: 'RE-NOID', formResponses: [{ fieldName: 'T-shirt size', response: 'L' }] });

  const list = await getAttendees(org, event._id);
  expect(list.status).toBe(200);
  // Both relabel to the current question label - neither is orphaned.
  const labels = list.body.registrations.flatMap((r) => (r.formResponses || []).map((a) => a.fieldName));
  expect(labels.filter((l) => l === 'T-shirt size').length).toBe(2);

  // The pure matcher resolves both shapes directly.
  expect(matchAnswerToQuestion({ qid: 'q-size', fieldName: 'old' }, [q])).toBe(q);
  expect(matchAnswerToQuestion({ fieldName: 'T-shirt size' }, [q])).toBe(q);
});

// --- AC9: renamed question -> one column (current label) carries old + new answers ---
test('AC9 after a rename, old and new answers share one column under the current label', async () => {
  const org = await createOrganiser();
  const q = choiceQ({ qid: 'q-meal', fieldName: 'Meal', fieldType: 'text', fieldOptions: [] });
  const event = await createFreeEvent(org, { hasActivity: true, registrationFields: [q] });
  const m1 = await createUser({ email: 'qe-ac9a@test.dev' });
  const m2 = await createUser({ email: 'qe-ac9b@test.dev' });
  // Both answers carry the id; they were asked under different labels (before/after a rename).
  await createFreeRegistration(event, m1, { registrationNumber: 'RE-OLD', formResponses: [{ fieldName: 'Meal', qid: 'q-meal', response: 'Veg' }] });
  await createFreeRegistration(event, m2, { registrationNumber: 'RE-NEW', formResponses: [{ fieldName: 'Meal preference', qid: 'q-meal', response: 'Non-veg' }] });

  // Rename the live question label.
  const renamed = await updateFree(org, event._id, [{ qid: 'q-meal', fieldName: 'Meal preference', fieldType: 'text', isRequired: false }]);
  expect(renamed.status).toBeLessThan(400);

  const list = await getAttendees(org, event._id);
  // The CSV column key is the question (by id); its heading is the current label; both answers land in it.
  expect(list.body.registrationFields[0].fieldName).toBe('Meal preference');
  const labels = list.body.registrations.flatMap((r) => (r.formResponses || []).map((a) => a.fieldName));
  expect(labels.every((l) => l === 'Meal preference')).toBe(true);
  const responses = list.body.registrations.flatMap((r) => (r.formResponses || []).map((a) => a.response)).sort();
  expect(responses).toEqual(['Non-veg', 'Veg']);
});
