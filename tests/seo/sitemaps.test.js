// The deals sitemap feed - see featureplans/shared-seo-plumbing.md. GET /api/dailydeals/sitemap
// returns live deals, each with id, title and updatedAt, and leaves out deals that are not currently
// live (inactive, offline, or out of date).
import { createOrganiser, createPartnerStore, createDeal } from '../helpers/factories.js';
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
