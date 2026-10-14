// Public "events by one organiser" page - see featureplans/events-by-organiser.md.
// The slug is a unique, format-enforced handle on the user; GET /events/by/:slug returns that
// organiser's published, upcoming/currently-running events (all types), and 404s an unknown slug.
import request from 'supertest';
import app from '../app.js';
import User from '../models/userModel.js';
import {
  createOrganiser, createUser, createFreeEvent, createPaidEvent, API_KEY,
} from './helpers/factories.js';

const byOrg = (slug) => request(app).get(`/api/events/by/${slug}`).set('x-api-key', API_KEY);

test('AC1 the slug is unique and format-enforced (lowercase/dashes; spaces + symbols rejected)', async () => {
  await User.syncIndexes(); // ensure the unique slug index exists in the test DB

  await createUser({ email: 'slug1@test.dev', slug: 'promoter-one' });
  // A second user cannot hold the same slug.
  await expect(createUser({ email: 'slug2@test.dev', slug: 'promoter-one' })).rejects.toThrow();

  // Uppercase is normalised to lowercase.
  const mixed = await createUser({ email: 'slug3@test.dev', slug: 'MixedCase' });
  expect(mixed.slug).toBe('mixedcase');

  // Spaces and symbols are rejected.
  await expect(createUser({ email: 'slug4@test.dev', slug: 'has space' })).rejects.toThrow();
  await expect(createUser({ email: 'slug5@test.dev', slug: 'bad_symbol!' })).rejects.toThrow();
});

test('AC2 the endpoint returns only the matched organiser events (by postedBy)', async () => {
  const a = await createOrganiser({ email: 'a@test.dev', slug: 'org-a' });
  const b = await createOrganiser({ email: 'b@test.dev', slug: 'org-b' });
  await createFreeEvent(a, { title: 'A Free' });
  await createPaidEvent(b, { title: 'B Paid' });

  const res = await byOrg('org-a');
  expect(res.status).toBe(200);
  const titles = res.body.events.map((e) => e.title);
  expect(titles).toContain('A Free');
  expect(titles).not.toContain('B Paid');
  expect(res.body.events.every((e) => String(e.postedBy) === String(a._id))).toBe(true);
});

test('AC3 returns upcoming + currently-running of all types; excludes past and offline', async () => {
  const a = await createOrganiser({ email: 'types@test.dev', slug: 'org-types' });
  const now = Date.now();
  await createFreeEvent(a, { title: 'Free Upcoming' });
  await createPaidEvent(a, { title: 'Paid Upcoming' });
  await createFreeEvent(a, { title: 'Promo Upcoming', isAdvertiseOnly: true });
  // currently running: started yesterday, expires in 2 days -> still shows.
  await createPaidEvent(a, {
    title: 'Running Now',
    dateTime: new Date(now - 24 * 3600 * 1000),
    expiryDate: new Date(now + 2 * 24 * 3600 * 1000),
  });
  // past: expired yesterday -> hidden.
  await createFreeEvent(a, {
    title: 'Past',
    dateTime: new Date(now - 10 * 24 * 3600 * 1000),
    expiryDate: new Date(now - 24 * 3600 * 1000),
  });
  // offline/draft (goLive false) -> hidden.
  await createPaidEvent(a, { title: 'Offline', goLive: false });

  const res = await byOrg('org-types');
  expect(res.status).toBe(200);
  const titles = res.body.events.map((e) => e.title);
  expect(titles).toEqual(expect.arrayContaining(['Free Upcoming', 'Paid Upcoming', 'Promo Upcoming', 'Running Now']));
  expect(titles).not.toContain('Past');
  expect(titles).not.toContain('Offline');
});

test('AC4 an unknown slug returns a not-found response', async () => {
  const res = await byOrg('no-such-organiser');
  expect(res.status).toBe(404);
});
