// The sitemap feeds - see featureplans/shared-seo-plumbing.md and feature 1013.
// GET /api/dailydeals/sitemap returns live deals, each with id, title and updatedAt, and leaves out
// deals that are not currently live (inactive, offline, or out of date).
// GET /api/adverts/sitemap lists live listings only; GET /api/events/sitemap lists upcoming events
// that are not switched off or cancelled; GET /api/sitemap/summary gives each list's count and
// newest change date, using the same rules (the frontend sitemap index hides empty lists).
import {
  createOrganiser, createPartnerStore, createDeal, createUser, createAdvert, createFreeEvent,
  createThread, createStore, createCampaign,
} from '../helpers/factories.js';
import { api } from '../helpers/eventRequests.js';

const getSitemap = () => api('get', '/api/dailydeals/sitemap');

test('the deals sitemap lists live deals with their id, title and last update', async () => {
  const owner = await createOrganiser();
  const store = await createPartnerStore(owner);
  const deal = await createDeal(store, owner, { dealTitle: 'Half Price Biryani' });

  const res = await getSitemap();
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);

  const entry = res.body.find((d) => String(d._id) === String(deal._id));
  expect(entry).toBeTruthy();
  expect(entry.title).toBe('Half Price Biryani');
  expect(entry.updatedAt).toBeTruthy();
});

test('the deals sitemap leaves out inactive, offline and expired deals', async () => {
  const owner = await createOrganiser();
  const store = await createPartnerStore(owner);
  const now = Date.now();

  const inactive = await createDeal(store, owner, { dealTitle: 'Inactive Deal', isActive: false });
  const offline = await createDeal(store, owner, { dealTitle: 'Offline Deal', isOnline: false });
  const expired = await createDeal(store, owner, {
    dealTitle: 'Expired Deal',
    startDate: new Date(now - 60 * 24 * 3600 * 1000),
    endDate: new Date(now - 30 * 24 * 3600 * 1000),
  });
  const live = await createDeal(store, owner, { dealTitle: 'Live Deal' });

  const res = await getSitemap();
  expect(res.status).toBe(200);
  const ids = res.body.map((d) => String(d._id));

  expect(ids).toContain(String(live._id));
  expect(ids).not.toContain(String(inactive._id));
  expect(ids).not.toContain(String(offline._id));
  expect(ids).not.toContain(String(expired._id));
});

const DAY = 24 * 3600 * 1000;
const idsOf = (res) => res.body.map((x) => String(x._id));

test('the listings sitemap lists live listings only, leaving out expired and switched-off ones', async () => {
  const poster = await createUser();
  const live = await createAdvert(poster, { title: 'Live Listing' });
  const expired = await createAdvert(poster, { title: 'Expired Listing', expiresAt: new Date(Date.now() - DAY) });
  const switchedOff = await createAdvert(poster, { title: 'Switched Off Listing', status: 'inactive' });

  const res = await api('get', '/api/adverts/sitemap');
  expect(res.status).toBe(200);
  const ids = idsOf(res);
  expect(ids).toContain(String(live._id));
  expect(ids).not.toContain(String(expired._id));
  expect(ids).not.toContain(String(switchedOff._id));
});

test('the events sitemap lists upcoming events only, leaving out finished, blocked, switched-off and cancelled ones', async () => {
  const organiser = await createOrganiser();
  const upcoming = await createFreeEvent(organiser, { title: 'Upcoming Event' });
  const finished = await createFreeEvent(organiser, { title: 'Finished Event', dateTime: new Date(Date.now() - 2 * DAY) });
  const blocked = await createFreeEvent(organiser, { title: 'Blocked Event', isBlocked: true });
  const switchedOff = await createFreeEvent(organiser, { title: 'Switched Off Event', goLive: false });
  const cancelled = await createFreeEvent(organiser, { title: 'Cancelled Event', deletedByOrganiser: true });

  const res = await api('get', '/api/events/sitemap');
  expect(res.status).toBe(200);
  const ids = idsOf(res);
  expect(ids).toContain(String(upcoming._id));
  for (const e of [finished, blocked, switchedOff, cancelled]) expect(ids).not.toContain(String(e._id));
});

test('the sitemap summary gives each list its count and newest change date, using the same rules as the lists', async () => {
  const empty = await api('get', '/api/sitemap/summary');
  expect(empty.status).toBe(200);
  for (const key of ['listings', 'events', 'threads', 'deals', 'coupons']) {
    expect(empty.body[key]).toEqual({ count: 0, lastmod: null });
  }

  const poster = await createOrganiser();
  await createAdvert(poster, { title: 'Live Listing' });
  await createAdvert(poster, { title: 'Expired Listing', expiresAt: new Date(Date.now() - DAY) });
  await createFreeEvent(poster, { title: 'Cancelled Event', deletedByOrganiser: true });
  await createThread(poster);
  const store = await createStore(poster);
  await createCampaign(store, poster);
  const newest = await createThread(poster, { title: 'Newest Thread' });

  const res = await api('get', '/api/sitemap/summary');
  expect(res.status).toBe(200);
  expect(res.body.listings.count).toBe(1);
  expect(res.body.events).toEqual({ count: 0, lastmod: null });
  expect(res.body.threads.count).toBe(2);
  expect(res.body.threads.lastmod).toBe(new Date(newest.updatedAt).toISOString());
  expect(res.body.deals).toEqual({ count: 0, lastmod: null });
  expect(res.body.coupons.count).toBe(1);
  expect(Date.parse(res.body.coupons.lastmod)).not.toBeNaN();
});

