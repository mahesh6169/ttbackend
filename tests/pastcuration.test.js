// featureplans/events-past-offline-curation.md
import request from 'supertest';
import app from '../app.js';
import { createOrganiser, createUser, createFreeEvent, cookieFor, API_KEY } from './helpers/factories.js';
import { isSalesOpen } from '../utils/events/ticketHelpers.js';

const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000);
const ids = (list) => (list || []).map((e) => String(e._id));

// ---------------------------------------------------------------------------
// AC1: admin curation list includes a finished OFFLINE event and reports its state;
//      an UPCOMING offline event is not in the list.
// ---------------------------------------------------------------------------
test('AC1 - admin curation list includes a finished event whose go-live flag is off, and the row reports that state; an upcoming offline event is not in the list', async () => {
  const org = await createOrganiser();
  const admin = await createUser({ role: 'admin' });

  const pastOffline = await createFreeEvent(org, {
    title: 'Past Offline Curation Fest',
    dateTime: daysAgo(10),
    expiryDate: daysAgo(3),
    goLive: false,
  });
  const upcomingOffline = await createFreeEvent(org, {
    title: 'Upcoming Offline Curation Fest',
    goLive: false,
  });

  const res = await request(app)
    .get('/api/admin/events/past-curation')
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(admin));

  expect(res.status).toBe(200);
  const row = res.body.events.find((e) => String(e._id) === String(pastOffline._id));
  expect(row).toBeTruthy();
  expect(row.offline).toBe(true);
  expect(ids(res.body.events)).not.toContain(String(upcomingOffline._id));
});

// ---------------------------------------------------------------------------
// AC2: a finished OFFLINE, admin-featured event is public; unfeatured it is not.
// ---------------------------------------------------------------------------
test('AC2 - a finished OFFLINE event that is admin-featured is returned by the public past-events endpoint; the same event unfeatured is not', async () => {
  const org = await createOrganiser();
  const event = await createFreeEvent(org, {
    title: 'Public Offline Past Fest',
    dateTime: daysAgo(9),
    expiryDate: daysAgo(2),
    goLive: false,
  });

  const before = await request(app).get('/api/events/past').set('x-api-key', API_KEY);
  expect(ids(before.body.events)).not.toContain(String(event._id));

  event.featuredInPast = true;
  await event.save();

  const after = await request(app).get('/api/events/past').set('x-api-key', API_KEY);
  expect(ids(after.body.events)).toContain(String(event._id));
});

// ---------------------------------------------------------------------------
// AC3: a finished ORGANISER-DELETED event stays eligible exactly as today (regression guard).
// ---------------------------------------------------------------------------
test('AC3 - a finished organiser-deleted event stays eligible for curation and the public strip (regression)', async () => {
  const org = await createOrganiser();
  const admin = await createUser({ role: 'admin' });
  const event = await createFreeEvent(org, {
    title: 'Deleted Past Curation Fest',
    dateTime: daysAgo(8),
    expiryDate: daysAgo(2),
    deletedByOrganiser: true,
    featuredInPast: true,
  });

  const curation = await request(app)
    .get('/api/admin/events/past-curation')
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(admin));
  expect(ids(curation.body.events)).toContain(String(event._id));

  const pub = await request(app).get('/api/events/past').set('x-api-key', API_KEY);
  expect(ids(pub.body.events)).toContain(String(event._id));
});

// ---------------------------------------------------------------------------
// AC4: RSVP for a free event whose event day has passed is refused; before the cutoff it registers.
// ---------------------------------------------------------------------------
test('AC4 - RSVP for a free event whose event day has passed is refused with the registration-closed error code; the same event before the cutoff still registers', async () => {
  const org = await createOrganiser();
  const member = await createUser();

  const closedEvent = await createFreeEvent(org, {
    title: 'Closed RSVP Fest',
    dateTime: daysAgo(2),
    timeZone: 'UTC',
    expiryDate: new Date(Date.now() + 5 * 24 * 3600 * 1000), // still within past-grace, isolates the RSVP cutoff
  });
  const closed = await request(app)
    .post(`/api/events/${closedEvent._id}/free/register`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(member))
    .send({ mobile: '0412345678', attendees: [{ name: 'A One' }] });
  expect(closed.status).toBe(400);
  expect(closed.body.errorCode).toBe('REGISTRATION_CLOSED');

  const openEvent = await createFreeEvent(org, {
    title: 'Open RSVP Fest',
    dateTime: new Date(),
    timeZone: 'UTC',
  });
  const open = await request(app)
    .post(`/api/events/${openEvent._id}/free/register`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(member))
    .send({ mobile: '0412345678', attendees: [{ name: 'A One' }] });
  expect(open.status).toBeLessThan(400);
});

// ---------------------------------------------------------------------------
// AC5: the cutoff is computed in the event's own timezone, not the server's day.
// The free-RSVP refusal reuses isSalesOpen unchanged (D6: no second date rule), so the
// helper's own timezone correctness - already proven for paid sales - is what AC4 above
// relies on for free RSVP too. This documents that reuse for the RSVP feature specifically.
// ---------------------------------------------------------------------------
test('AC5 - the RSVP cutoff (via the reused isSalesOpen helper) is computed in the event own timezone, not the server/UTC day', () => {
  // Event dateTime = yesterday 18:00 UTC. In Australia/Perth (UTC+8) that lands at 02:00 the
  // next day - i.e. the event's LOCAL calendar day is "today" Perth, even though the stored
  // dateTime reads as "yesterday" in UTC. The 11:59:59pm Perth cutoff for that local day is
  // today 15:59:59 UTC.
  const yesterday18Utc = new Date(Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate() - 1,
    18, 0, 0
  ));
  const event = { dateTime: yesterday18Utc, timeZone: 'Australia/Perth' };

  // 14:00 UTC today = 22:00 Perth today - the local-day cutoff (23:59:59 Perth) has not passed -> OPEN.
  const nowAt14Utc = new Date(Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
    14, 0, 0
  ));
  expect(isSalesOpen(event, nowAt14Utc)).toBe(true);

  // 16:30 UTC today = 00:30 the next day Perth - the local-day cutoff has passed -> CLOSED.
  const nowAt1630Utc = new Date(Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
    16, 30, 0
  ));
  expect(isSalesOpen(event, nowAt1630Utc)).toBe(false);
});
