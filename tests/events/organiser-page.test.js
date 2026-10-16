// The public "events by one organiser" page - see featureplans/events-by-organiser.md and
// events-organiser-share-meta.md. The slug is a unique, format-enforced handle on the user;
// GET /events/by/:slug returns that organiser's published, upcoming/currently-running events (all
// types), their display name and their three optional share-card fields, and 404s an unknown slug.
// The rendered share card is proven in ttfrontend organiserShareMeta.spec.js.
import User from '../../models/userModel.js';
import { createOrganiser, createUser, createFreeEvent, createPaidEvent } from '../helpers/factories.js';
import { byOrg } from '../helpers/eventRequests.js';
import { daysAgo, daysFromNow } from '../helpers/dates.js';

describe('organiser slug', () => {
  test('an organiser slug is unique, lowercased, and rejects spaces and symbols', async () => {
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

  test('an unknown organiser slug returns not found', async () => {
    const res = await byOrg('no-such-organiser');
    expect(res.status).toBe(404);
  });
});

describe('events listed', () => {
  test('the page lists only that organiser\'s events', async () => {
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

  test('the page lists upcoming and running events of every type, but not past or offline ones', async () => {
    const a = await createOrganiser({ email: 'types@test.dev', slug: 'org-types' });
    await createFreeEvent(a, { title: 'Free Upcoming' });
    await createPaidEvent(a, { title: 'Paid Upcoming' });
    await createFreeEvent(a, { title: 'Promo Upcoming', isAdvertiseOnly: true });
    // currently running: started yesterday, expires in 2 days -> still shows.
    await createPaidEvent(a, { title: 'Running Now', dateTime: daysAgo(1), expiryDate: daysFromNow(2) });
    // past: expired yesterday -> hidden.
    await createFreeEvent(a, { title: 'Past', dateTime: daysAgo(10), expiryDate: daysAgo(1) });
    // offline/draft (goLive false) -> hidden.
    await createPaidEvent(a, { title: 'Offline', goLive: false });

    const res = await byOrg('org-types');
    expect(res.status).toBe(200);
    const titles = res.body.events.map((e) => e.title);
    expect(titles).toEqual(expect.arrayContaining(['Free Upcoming', 'Paid Upcoming', 'Promo Upcoming', 'Running Now']));
    expect(titles).not.toContain('Past');
    expect(titles).not.toContain('Offline');
  });
});

describe('name and share card', () => {
  test('an organiser with no share fields gets them back empty, alongside the name and events', async () => {
    const org = await createOrganiser({ email: 'share-none@test.dev', slug: 'share-none' });
    await createFreeEvent(org, { title: 'Share None Fest', organizer: { name: 'Share None Co', contact: '0412345678' } });

    const res = await byOrg('share-none');
    expect(res.status).toBe(200);
    expect(res.body.organiserName).toBe('Share None Co');
    expect(Array.isArray(res.body.events)).toBe(true);
    // Unset share fields come back empty/falsy.
    expect(res.body.organiserShareTitle).toBeFalsy();
    expect(res.body.organiserShareDescription).toBeFalsy();
    expect(res.body.organiserShareImage).toBeFalsy();
  });

  test('an organiser with share fields set gets those exact values, and the share title becomes the display name', async () => {
    const org = await createOrganiser({
      email: 'share-set@test.dev',
      slug: 'share-set',
      organiserShareTitle: 'Diwali Nights by Aurora Events',
      organiserShareDescription: 'Book your Diwali tickets before they sell out!',
      organiserShareImage: 'https://cdn.example.com/aurora-share.jpg',
    });
    await createFreeEvent(org, { title: 'Share Set Fest', organizer: { name: 'Aurora Events', contact: '0412345678' } });

    const res = await byOrg('share-set');
    expect(res.status).toBe(200);
    expect(res.body.organiserShareTitle).toBe('Diwali Nights by Aurora Events');
    expect(res.body.organiserShareDescription).toBe('Book your Diwali tickets before they sell out!');
    expect(res.body.organiserShareImage).toBe('https://cdn.example.com/aurora-share.jpg');
    // The share title wins over the event's own organizer.name ('Aurora Events').
    expect(res.body.organiserName).toBe('Diwali Nights by Aurora Events');
  });

  test('without a share title the display name falls back to the event\'s organiser name', async () => {
    const org = await createOrganiser({ email: 'share-fallback@test.dev', slug: 'share-fallback' });
    await createFreeEvent(org, { title: 'Fallback Fest', organizer: { name: 'Fallback Co', contact: '0412345678' } });

    const res = await byOrg('share-fallback');
    expect(res.status).toBe(200);
    expect(res.body.organiserName).toBe('Fallback Co');
  });
});
