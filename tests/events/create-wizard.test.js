// Server backstop for the create-event wizard - see featureplans/events-wizard-validation.md.
// The wizard checks these inline; these prove the create endpoint is the wall for the money and
// correctness basics. The layered UI validation itself is proven in
// ttfrontend/e2e/wizardvalidation.spec.js.
import { createOrganiser } from '../helpers/factories.js';
import { addFree, addPaid, FUTURE, PAST } from '../helpers/eventRequests.js';

test('creating an event with a past date is rejected; a future date is accepted', async () => {
  const organiser = await createOrganiser();
  const res = await addFree(organiser, { dateTime: PAST() });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/future/i);

  const ok = await addFree(organiser, { dateTime: FUTURE() });
  expect(ok.status).toBe(201);
});

test('creating a paid event with no ticket types (empty list or missing) is rejected', async () => {
  const organiser = await createOrganiser();

  const empty = await addPaid(organiser, { ticketTypes: [] });
  expect(empty.status).toBe(400);
  expect(empty.body.message).toMatch(/ticket type/i);

  const absent = await addPaid(organiser, { ticketTypes: null });
  expect(absent.status).toBe(400);
  expect(absent.body.message).toMatch(/ticket type/i);
});

// The single home of the "$1 minimum ticket price" rule.
test('creating a paid event with a ticket price below $1 is rejected', async () => {
  const organiser = await createOrganiser();
  const res = await addPaid(organiser, { ticketTypes: [{ name: 'Cheap', price: 0.5 }] });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/minimum ticket price is \$1/i);
});

test('a promo event needs a valid https ticket link', async () => {
  const organiser = await createOrganiser();

  const missing = await addFree(organiser, { eventIntent: 'promote' });
  expect(missing.status).toBe(400);
  expect(missing.body.message).toMatch(/https|external/i);

  const httpOnly = await addFree(organiser, { eventIntent: 'promote', externalTicketUrl: 'http://example.com/tickets' });
  expect(httpOnly.status).toBe(400);

  const notAUrl = await addFree(organiser, { eventIntent: 'promote', externalTicketUrl: 'just some text' });
  expect(notAUrl.status).toBe(400);

  const ok = await addFree(organiser, { eventIntent: 'promote', externalTicketUrl: 'https://example.com/tickets' });
  expect(ok.status).toBe(201);
});
