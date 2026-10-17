// Share-preview refresh: after an edit is saved, the backend asks the frontend to drop its cached
// copy of that page (POST <frontend>/api/revalidate with the shared REVALIDATION_SECRET), so a link
// shared straight away shows the new title/image in WhatsApp/Facebook. A stand-in "frontend" HTTP
// server records the calls. The refresh never blocks or fails the save.
import http from 'http';
import { createUser, createOrganiser, createFreeEvent, createPaidEvent, createAdvert, createThread,
  createStore, createCampaign, createPartnerStore, createDeal } from '../helpers/factories.js';
import { api, updateFree, updatePaid } from '../helpers/eventRequests.js';

const SECRET = 'jest-revalidation-secret';
let server;
let calls = [];
let saved;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls.push({ path: req.url, secret: req.headers['x-revalidation-secret'], tag: JSON.parse(body || '{}').tag });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"success":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  saved = { url: process.env.REVALIDATE_URL, secret: process.env.REVALIDATION_SECRET };
});

beforeEach(() => {
  calls = [];
  process.env.REVALIDATE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.REVALIDATION_SECRET = SECRET;
});

afterAll(async () => {
  for (const [key, value] of [['REVALIDATE_URL', saved.url], ['REVALIDATION_SECRET', saved.secret]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise((resolve) => server.close(resolve));
});

const tags = () => calls.map((c) => c.tag).sort();

test('editing a free event refreshes its page with the shared secret', async () => {
  const organiser = await createOrganiser();
  const event = await createFreeEvent(organiser);

  const res = await updateFree(organiser, event._id, { title: 'Renamed Free Event' });
  expect(res.status).toBe(200);
  expect(calls).toEqual([{ path: '/api/revalidate', secret: SECRET, tag: `event-${event._id}` }]);
});

test('editing a paid event refreshes its page', async () => {
  const organiser = await createOrganiser();
  const event = await createPaidEvent(organiser);

  const res = await updatePaid(organiser, event._id, { title: 'Renamed Paid Event' });
  expect(res.status).toBe(200);
  expect(tags()).toEqual([`event-${event._id}`]);
});

test('editing a listing refreshes its page', async () => {
  const poster = await createUser();
  const advert = await createAdvert(poster);

  const res = await api('put', `/api/adverts/updateAdvert/${advert._id}`, poster)
    .field('title', 'Renamed Listing');
  expect(res.status).toBe(200);
  expect(tags()).toEqual([`listing-${advert._id}`]);
});

test('editing a thread refreshes its page', async () => {
  const owner = await createUser();
  const thread = await createThread(owner);

  const res = await api('put', `/api/threads/update/${thread._id}`, owner)
    .field('title', 'Renamed Thread')
    .field('question', 'Updated question text.');
  expect(res.status).toBe(200);
  expect(tags()).toEqual([`thread-${thread._id}`]);
});

test('editing a coupon campaign refreshes its page, and editing its store refreshes every campaign of the store', async () => {
  const admin = await createUser({ role: 'admin' });
  const store = await createStore(admin);
  const campaign = await createCampaign(store, admin);
  const other = await createCampaign(store, admin);

  const res = await api('put', `/api/admin/campaigns/${campaign._id}`, admin).send({ discount: '30% off' });
  expect(res.status).toBe(200);
  expect(tags()).toEqual([`campaign-${campaign.slug}`]);

  calls = [];
  const storeRes = await api('put', `/api/admin/stores/${store._id}`, admin).field('storeName', 'Renamed Store');
  expect(storeRes.status).toBe(200);
  expect(tags()).toEqual([`campaign-${campaign.slug}`, `campaign-${other.slug}`].sort());
});

test('editing a daily deal refreshes its page, from the poster and from admin', async () => {
  const poster = await createUser();
  const admin = await createUser({ role: 'admin' });
  const partner = await createPartnerStore(poster);
  const deal = await createDeal(partner, poster);

  const res = await api('put', `/api/user/dailydeals/${deal._id}`, poster).field('dealTitle', 'Renamed Deal');
  expect(res.status).toBe(200);
  expect(tags()).toEqual([`deal-${deal._id}`]);

  calls = [];
  const adminRes = await api('put', `/api/admin/dailydeals/${deal._id}`, admin).field('dealTitle', 'Admin Renamed Deal');
  expect(adminRes.status).toBe(200);
  expect(tags()).toEqual([`deal-${deal._id}`]);
});

test('without a secret configured nothing is sent, and the edit still saves', async () => {
  delete process.env.REVALIDATION_SECRET;
  const organiser = await createOrganiser();
  const event = await createFreeEvent(organiser);

  const res = await updateFree(organiser, event._id, { title: 'Saved Without Refresh' });
  expect(res.status).toBe(200);
  expect(calls).toEqual([]);
});

test('an unreachable frontend does not fail the edit', async () => {
  process.env.REVALIDATE_URL = 'http://127.0.0.1:9'; // nothing listens on the discard port
  const organiser = await createOrganiser();
  const event = await createFreeEvent(organiser);

  const res = await updateFree(organiser, event._id, { title: 'Saved Despite Refresh Failure' });
  expect(res.status).toBe(200);
  expect(res.body.event.title).toBe('Saved Despite Refresh Failure');
});
