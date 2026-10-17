// The public Past strip and the admin past-curation list - see featureplans/events-past-events.md and
// events-past-offline-curation.md. Past is decided by DATE (not the stale stored status), and only
// events an admin has featured are public. Offline and organiser-deleted past events stay eligible.
import { createOrganiser, createUser, createFreeEvent } from '../helpers/factories.js';
import { api, pastEventIds } from '../helpers/eventRequests.js';
import { daysAgo, ids } from '../helpers/dates.js';

const curationList = (admin) => api('get', '/api/admin/events/past-curation', admin);
const setFeatured = (event, admin, featured) =>
  api('patch', `/api/admin/events/${event._id}/past-featured`, admin).send({ featured });

test('only finished events an admin has featured appear in the Past strip, offline ones included', async () => {
  const org = await createOrganiser();
  const admin = await createUser({ role: 'admin' });

  // A FEATURED past event whose STORED status is a stale "active" (status is only recomputed on save)
  // appears: past is by date.
  const past = await createFreeEvent(org, {
    title: 'Past Fest', status: 'active', dateTime: daysAgo(10), expiryDate: daysAgo(3), featuredInPast: true,
  });
  // A featured but FUTURE event does not (it is not past).
  const future = await createFreeEvent(org, { title: 'Future Fest', featuredInPast: true });
  // A past event the admin has NOT featured does not (curation gate).
  const unfeatured = await createFreeEvent(org, {
    title: 'Unfeatured Past Fest', dateTime: daysAgo(9), expiryDate: daysAgo(2),
  });

  let shown = await pastEventIds();
  expect(shown).toContain(String(past._id));
  expect(shown).not.toContain(String(future._id));
  expect(shown).not.toContain(String(unfeatured._id));

  // A finished OFFLINE event (go-live off) is absent until the admin features it, then appears, and
  // disappears again when unfeatured.
  const offline = await createFreeEvent(org, {
    title: 'Public Offline Past Fest', dateTime: daysAgo(8), expiryDate: daysAgo(3), goLive: false,
  });
  expect(await pastEventIds()).not.toContain(String(offline._id));

  const on = await setFeatured(offline, admin, true);
  expect(on.status).toBe(200);
  expect(on.body.featuredInPast).toBe(true);
  expect(await pastEventIds()).toContain(String(offline._id));

  const off = await setFeatured(offline, admin, false);
  expect(off.status).toBe(200);
  shown = await pastEventIds();
  expect(shown).not.toContain(String(offline._id));
});

test('the admin curation list includes a finished offline event and flags it offline; an upcoming offline event is not listed', async () => {
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

  const res = await curationList(admin);
  expect(res.status).toBe(200);
  const row = res.body.events.find((e) => String(e._id) === String(pastOffline._id));
  expect(row).toBeTruthy();
  expect(row.offline).toBe(true);
  expect(ids(res.body.events)).not.toContain(String(upcomingOffline._id));
});

test('a finished organiser-deleted event stays in the curation list and, when featured, in the Past strip', async () => {
  const org = await createOrganiser();
  const admin = await createUser({ role: 'admin' });
  const event = await createFreeEvent(org, {
    title: 'Deleted Past Curation Fest',
    dateTime: daysAgo(8),
    expiryDate: daysAgo(2),
    deletedByOrganiser: true,
    featuredInPast: true,
  });

  const curation = await curationList(admin);
  expect(ids(curation.body.events)).toContain(String(event._id));

  expect(await pastEventIds()).toContain(String(event._id));
});
