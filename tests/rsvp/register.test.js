// The free-RSVP flow: a member registers, the registration lands in the DB with a confirmation
// email, duplicates are refused, the capacity view counts attendees, and RSVP closes once the event
// day has passed.
//
// KNOWN BUG (surfaced 2026-07-28): the only transaction-protected capacity guard is the paid
// confirm-payment path. Free RSVP is check-then-act and OVERSELLS under parallel fire; the last test
// documents that with test.failing, which stays green until the free path is made atomic.
import FreeTicket from '../../models/freeTicket.js';
import { createOrganiser, createUser, createFreeEvent } from '../helpers/factories.js';
import { registerFree } from '../helpers/eventRequests.js';
import { viewCapacity } from '../helpers/seating.js';
import { clearEmailsBeforeEach, getCapturedEmails } from '../helpers/email.js';
import { daysAgo, daysFromNow } from '../helpers/dates.js';

clearEmailsBeforeEach();

test('a member RSVPs a free event: the registration is saved and a confirmation email is sent', async () => {
  const organiser = await createOrganiser();
  const member = await createUser({ email: 'attendee@test.dev' });
  const event = await createFreeEvent(organiser);

  const res = await registerFree(event, member, { attendees: [{ name: 'Alice Attendee' }] });
  expect(res.status).toBeLessThan(400);
  expect(res.body.success).toBe(true);

  // Registration is in the DB.
  expect(await FreeTicket.countDocuments()).toBe(1);

  // A confirmation email to the attendee was produced (captured, never sent).
  const confirmation = getCapturedEmails().find(
    (e) => e.to === 'attendee@test.dev' && /Registration Confirmed/.test(e.subject)
  );
  expect(confirmation).toBeTruthy();
  expect(confirmation.subject).toContain(event.title);
});

test('the same member cannot RSVP the same event twice', async () => {
  const organiser = await createOrganiser();
  const member = await createUser();
  const event = await createFreeEvent(organiser);

  const first = await registerFree(event, member);
  expect(first.status).toBeLessThan(400);

  const second = await registerFree(event, member);
  expect(second.status).toBe(400);
  expect(second.body.message).toMatch(/already registered/i);
});

test('the capacity view counts every attendee on an RSVP', async () => {
  const organiser = await createOrganiser();
  const member = await createUser();
  const event = await createFreeEvent(organiser, { capacity: 10 });

  const before = await viewCapacity(event);
  expect(before.status).toBe(200);
  expect(before.body.capacity.total).toBe(10);
  expect(before.body.capacity.sold).toBe(0);
  expect(before.body.capacity.remaining).toBe(10);
  expect(before.body.capacity.status).toBe('available');

  // Register two attendees on one RSVP.
  const rsvp = await registerFree(event, member, { attendees: [{ name: 'A One' }, { name: 'B Two' }] });
  expect(rsvp.status).toBeLessThan(400);

  const after = await viewCapacity(event);
  expect(after.body.capacity.sold).toBe(2);
  expect(after.body.capacity.remaining).toBe(8);
});

// The cutoff reuses isSalesOpen (event-timezone aware - proven in tests/tickets/sales-cutoff.test.js).
test('RSVP is refused once the event day has passed, and still open on the day itself', async () => {
  const org = await createOrganiser();
  const member = await createUser();

  const closedEvent = await createFreeEvent(org, {
    title: 'Closed RSVP Fest',
    dateTime: daysAgo(2),
    timeZone: 'UTC',
    expiryDate: daysFromNow(5), // still within past-grace, isolates the RSVP cutoff
  });
  const closed = await registerFree(closedEvent, member, { attendees: [{ name: 'A One' }] });
  expect(closed.status).toBe(400);
  expect(closed.body.errorCode).toBe('REGISTRATION_CLOSED');

  const openEvent = await createFreeEvent(org, {
    title: 'Open RSVP Fest',
    dateTime: new Date(),
    timeZone: 'UTC',
  });
  const open = await registerFree(openEvent, member, { attendees: [{ name: 'A One' }] });
  expect(open.status).toBeLessThan(400);
});

// KNOWN BUG (documented, not silently passed): two parallel RSVPs for a capacity-1 event BOTH
// succeed today. test.failing is green while the bug exists and will start failing the moment the
// free path is made atomic - prompting a fix-up.
test.failing('KNOWN OVERSELL: capacity-1 free event should let exactly one RSVP win', async () => {
  const organiser = await createOrganiser();
  const [alice, bob] = await Promise.all([
    createUser({ email: 'race-alice@test.dev' }),
    createUser({ email: 'race-bob@test.dev' }),
  ]);
  const event = await createFreeEvent(organiser, { capacity: 1 });

  const attempt = (member) => registerFree(event, member, { attendees: [{ name: 'Racer' }] });

  const results = await Promise.all([attempt(alice), attempt(bob)]);
  const winners = results.filter((r) => r.status < 400);

  // This is the guarantee we WANT. It fails today (both win) - which is the point of test.failing.
  expect(winners.length).toBe(1);
});
