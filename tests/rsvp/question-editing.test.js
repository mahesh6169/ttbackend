// Stable question ids and editing questions after people have answered - see
// featureplans/events-rsvp-question-editing.md. Every question carries a stable qid preserved across
// saves; answers link by qid (text kept); free events allow label-safe edits after activity while
// meaning-changing edits stay locked; paid stays fully frozen; displays/CSV match answers by id
// first, name as a fallback.
import Event from '../../models/eventModel.js';
import FreeTicket from '../../models/freeTicket.js';
import {
  createOrganiser,
  createUser,
  createFreeEvent,
  createPaidEvent,
  createFreeRegistration,
} from '../helpers/factories.js';
import { api, addFree as postFree, updateFree as putFree, updatePaid as putPaid, registerFree } from '../helpers/eventRequests.js';
import { matchAnswerToQuestion, stampAnswerIds } from '../../utils/events/answerMatching.js';

// The question-focused shapes of the shared builders.
const addFree = (organiser, registrationFields) => postFree(organiser, { registrationFields });
const updateFree = (organiser, eventId, registrationFields) => putFree(organiser, eventId, { registrationFields });
const updatePaid = (organiser, eventId, registrationFields) => putPaid(organiser, eventId, { registrationFields });
const register = (user, event, formResponses) => registerFree(event, user, { formResponses });

const getAttendees = (organiser, eventId) =>
  api('get', `/api/events/${eventId}/free/attendees?limit=1000`, organiser);

const fieldsOf = async (eventId) => (await Event.findById(eventId)).registrationFields;

// A finalized-shape free choice question (with a stable qid), for lock tests seeded via the factory.
const choiceQ = (over = {}) => ({
  qid: 'q-size', fieldName: 'T-shirt size', fieldType: 'select',
  fieldOptions: ['S', 'M', 'L'], isRequired: false, includeTime: false,
  blockingOptions: [], blockingMessage: '', ...over,
});

test('a question keeps the same id across saves', async () => {
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

test('an older question without an id gets one on its next save and keeps it', async () => {
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

test('a saved answer carries both the question id and the question text (free and paid)', async () => {
  const org = await createOrganiser();
  const member = await createUser({ email: 'qe-3@test.dev' });
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

test('renaming an answered free-event question is allowed; old answers keep their text but show under the new label', async () => {
  const org = await createOrganiser();
  const member = await createUser({ email: 'qe-4@test.dev' });
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

test('an answered choice question can gain options but cannot lose or rename one', async () => {
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

test('an answered question cannot change type, toggle "also ask time", change blocking, or be deleted', async () => {
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

test('any edit to an answered paid-event question is refused, even a rename or added option', async () => {
  const org = await createOrganiser();
  const paidQ = { qid: 'q-notes', fieldName: 'Notes', fieldType: 'text', fieldOptions: [], isRequired: false, includeTime: false, blockingOptions: [], blockingMessage: '' };

  const eRename = await createPaidEvent(org, { hasActivity: true, registrationFields: [paidQ] });
  expect((await updatePaid(org, eRename._id, [{ ...paidQ, fieldName: 'Extra notes' }])).status).toBe(409);

  const eDrop = await createPaidEvent(org, { hasActivity: true, registrationFields: [{ ...paidQ, qid: 'q-sz', fieldName: 'Size', fieldType: 'select', fieldOptions: ['S', 'M'] }] });
  // Even an append (label-safe on FREE) is frozen on paid.
  expect((await updatePaid(org, eDrop._id, [{ qid: 'q-sz', fieldName: 'Size', fieldType: 'select', fieldOptions: ['S', 'M', 'L'], isRequired: false }])).status).toBe(409);
});

test('answers with and without question ids on the same event both match their question', async () => {
  const org = await createOrganiser();
  const q = choiceQ();
  const event = await createFreeEvent(org, { hasActivity: true, registrationFields: [q] });
  const m1 = await createUser({ email: 'qe-8a@test.dev' });
  const m2 = await createUser({ email: 'qe-8b@test.dev' });
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

test('after a rename, old and new answers share one column under the current label', async () => {
  const org = await createOrganiser();
  const q = choiceQ({ qid: 'q-meal', fieldName: 'Meal', fieldType: 'text', fieldOptions: [] });
  const event = await createFreeEvent(org, { hasActivity: true, registrationFields: [q] });
  const m1 = await createUser({ email: 'qe-9a@test.dev' });
  const m2 = await createUser({ email: 'qe-9b@test.dev' });
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
