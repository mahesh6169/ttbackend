// Blocking answers on free-RSVP dropdown questions - see featureplans/events-rsvp-blocking-questions.md.
// The registration path refuses an RSVP whose answer is a blocking option, with the organiser's
// message (or the default). How the organiser's blocking config is cleaned on save is covered in
// tests/rsvp/question-types.test.js.
import FreeTicket from '../../models/freeTicket.js';
import { createOrganiser, createUser, createFreeEvent } from '../helpers/factories.js';
import { registerFree } from '../helpers/eventRequests.js';
import { DEFAULT_BLOCK_MESSAGE } from '../../utils/constants/registrationMessages.js';

const register = (user, event, formResponses) => registerFree(event, user, { formResponses });

const ageQuestion = (overrides = {}) => ({
  fieldName: 'Are you 18 or over?',
  fieldType: 'select',
  fieldOptions: ['Yes', 'No'],
  blockingOptions: ['No'],
  isRequired: true,
  ...overrides,
});

test('a blocking answer refuses the RSVP with the organiser\'s message', async () => {
  const org = await createOrganiser();
  const member = await createUser({ email: 'block-msg@test.dev' });
  const event = await createFreeEvent(org, {
    registrationFields: [ageQuestion({ blockingMessage: 'Sorry, this event is 18+ only.' })],
  });
  const res = await register(member, event, [{ fieldName: 'Are you 18 or over?', response: 'No' }]);
  expect(res.status).toBe(400);
  expect(res.body.message).toBe('Sorry, this event is 18+ only.');
});

test('with no organiser message the refusal uses the default message', async () => {
  const org = await createOrganiser();
  const member = await createUser({ email: 'block-default@test.dev' });
  const event = await createFreeEvent(org, { registrationFields: [ageQuestion({ blockingMessage: '' })] });
  const res = await register(member, event, [{ fieldName: 'Are you 18 or over?', response: 'No' }]);
  expect(res.status).toBe(400);
  expect(res.body.message).toBe(DEFAULT_BLOCK_MESSAGE);
});

test('skipping or emptying a blocking question refuses the RSVP (it is required)', async () => {
  const org = await createOrganiser();
  const event = await createFreeEvent(org, { registrationFields: [ageQuestion()] });

  const m1 = await createUser({ email: 'block-skip-a@test.dev' });
  expect((await register(m1, event, [])).status).toBe(400); // omitted

  const m2 = await createUser({ email: 'block-skip-b@test.dev' });
  expect((await register(m2, event, [{ fieldName: 'Are you 18 or over?', response: '' }])).status).toBe(400); // empty
});

test('a non-blocking answer registers normally', async () => {
  const org = await createOrganiser();
  const member = await createUser({ email: 'block-ok@test.dev' });
  const event = await createFreeEvent(org, { registrationFields: [ageQuestion()] });
  const res = await register(member, event, [{ fieldName: 'Are you 18 or over?', response: 'Yes' }]);
  expect(res.status).toBeLessThan(400);
  expect(res.body.success).toBe(true);
  expect(await FreeTicket.countDocuments({ event: event._id })).toBe(1);
});

test('blocking applies per question, not to the same answer on other questions', async () => {
  const org = await createOrganiser();
  const member = await createUser({ email: 'block-scope@test.dev' });
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

test('the block matches the exact stored option text, so it survives the organiser renaming the option', async () => {
  const org = await createOrganiser();
  const member = await createUser({ email: 'block-rename@test.dev' });
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

test('a guest is refused by a blocking answer exactly like a member', async () => {
  const org = await createOrganiser();
  const guest = await createUser({ role: 'guest', email: 'block-guest@test.dev' });
  const event = await createFreeEvent(org, { registrationFields: [ageQuestion({ blockingMessage: 'No entry.' })] });
  const res = await register(guest, event, [{ fieldName: 'Are you 18 or over?', response: 'No' }]);
  expect(res.status).toBe(400);
  expect(res.body.message).toBe('No entry.');
});

test('an event with no blocking questions registers as normal', async () => {
  const org = await createOrganiser();
  const member = await createUser({ email: 'block-none@test.dev' });
  const event = await createFreeEvent(org, {
    registrationFields: [{ fieldName: 'Dietary needs', fieldType: 'text', isRequired: false }],
  });
  const res = await register(member, event, [{ fieldName: 'Dietary needs', response: 'None' }]);
  expect(res.status).toBeLessThan(400);
  expect(res.body.success).toBe(true);
});
