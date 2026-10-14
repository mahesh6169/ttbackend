// Plan: featureplans/shared-seo-plumbing.md - AC1 (deals sitemap backend feed).
// Proves GET /api/dailydeals/sitemap returns active/public deals, each with id, title and
// updatedAt, and excludes deals that are not currently live (inactive, offline, or out of date).
import request from 'supertest';
import app from '../app.js';
import { createOrganiser, createPartnerStore, createDeal, API_KEY } from './helpers/factories.js';

const getSitemap = () =>
  request(app).get('/api/dailydeals/sitemap').set('x-api-key', API_KEY);

test('AC1 the deals sitemap endpoint returns active deals with id, title and updatedAt', async () => {
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

test('AC1 the deals sitemap endpoint excludes deals that are not currently live', async () => {
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
