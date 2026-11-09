// Share-preview refresh: after an edit is saved, the backend asks the frontend to drop its cached
// copy of that page (POST <frontend>/api/revalidate with the shared REVALIDATION_SECRET), so a link
// shared straight away shows the new title/image in WhatsApp/Facebook. Feature 1014: create, edit,
// delete, go-live and admin actions also refresh the section landing (events-list, listings-list,
// deals-list, coupons-list; events/listings also cover the home page), so changes show straight away.
// A stand-in "frontend" HTTP server records the calls. The refresh never blocks or fails the save.
import http from 'http';
import { createUser, createOrganiser, createFreeEvent, createPaidEvent, createAdvert, createThread,
  createStore, createCampaign, createPartnerStore, createDeal } from '../helpers/factories.js';
import { api, addFree, updateFree, updatePaid } from '../helpers/eventRequests.js';

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

test('editing a free event refreshes its page and the events list with the shared secret', async () => {
  const organiser = await createOrganiser();
  const event = await createFreeEvent(organiser);

  const res = await updateFree(organiser, event._id, { title: 'Renamed Free Event' });
  expect(res.status).toBe(200);
  expect(calls.map((c) => c.path)).toEqual(['/api/revalidate', '/api/revalidate']);
  expect(calls.every((c) => c.secret === SECRET)).toBe(true);
  expect(tags()).toEqual(['events-list', `event-${event._id}`].sort());
});

test('creating, switching off and deleting an event refreshes the events list (and home) straight away', async () => {
  const organiser = await createOrganiser();
  const created = await addFree(organiser);
  expect(created.status).toBe(201);
  expect(tags()).toEqual(['events-list']);
  const id = created.body.event._id;

  calls = [];
  const off = await api('patch', `/api/events/${id}/toggle-golive`, organiser).send({ goLive: false });
  expect(off.status).toBe(200);
  expect(tags()).toEqual(['events-list', `event-${id}`].sort());

  calls = [];
  const del = await api('delete', `/api/events/${id}`, organiser);
  expect(del.status).toBe(200);
  expect(tags()).toEqual(['events-list', `event-${id}`].sort());
});

test('admin blocking or deleting an event refreshes its page and the events list', async () => {
  const organiser = await createOrganiser();
  const admin = await createUser({ role: 'admin' });
  const blocked = await createFreeEvent(organiser);
  const deleted = await createFreeEvent(organiser);

  const blockRes = await api('patch', `/api/admin/events/${blocked._id}/block`, admin);
  expect(blockRes.status).toBe(200);
  expect(tags()).toEqual(['events-list', `event-${blocked._id}`].sort());

  calls = [];
  const delRes = await api('delete', `/api/admin/events/byid/${deleted._id}`, admin);
  expect(delRes.status).toBe(200);
  expect(tags()).toEqual(['events-list', `event-${deleted._id}`].sort());
});

test('editing a paid event refreshes its page and the events list', async () => {
  const organiser = await createOrganiser();
  const event = await createPaidEvent(organiser);

  const res = await updatePaid(organiser, event._id, { title: 'Renamed Paid Event' });
  expect(res.status).toBe(200);
  expect(tags()).toEqual(['events-list', `event-${event._id}`].sort());
});

test('editing a listing refreshes its page and the listings list', async () => {
  const poster = await createUser();
  const advert = await createAdvert(poster);

  const res = await api('put', `/api/adverts/updateAdvert/${advert._id}`, poster)
    .field('title', 'Renamed Listing');
  expect(res.status).toBe(200);
  expect(tags()).toEqual([`listing-${advert._id}`, 'listings-list'].sort());
});

test('switching a listing off, deleting it, and admin renew/delete refresh its page and the listings list', async () => {
  const poster = await createUser();
  const admin = await createUser({ role: 'admin' });
  const advert = await createAdvert(poster);
  const other = await createAdvert(poster);
  const expected = (id) => [`listing-${id}`, 'listings-list'].sort();

  const off = await api('patch', `/api/adverts/${advert._id}/toggle-golive`, poster).send({ goLive: false });
  expect(off.status).toBe(200);
  expect(tags()).toEqual(expected(advert._id));

  calls = [];
  const del = await api('delete', `/api/adverts/delete/${advert._id}`, poster);
  expect(del.status).toBe(200);
  expect(tags()).toEqual(expected(advert._id));

  calls = [];
  const renew = await api('put', `/api/admin/adverts/${other._id}/renew`, admin);
  expect(renew.status).toBe(200);
  expect(tags()).toEqual(expected(other._id));

  calls = [];
  const adminDel = await api('delete', `/api/admin/adverts/byid/${other._id}`, admin);
  expect(adminDel.status).toBe(200);
  expect(tags()).toEqual(expected(other._id));
});

test('editing a thread refreshes its page and the thread lists', async () => {
  const owner = await createUser();
  const thread = await createThread(owner);

  const res = await api('put', `/api/threads/update/${thread._id}`, owner)
    .field('title', 'Renamed Thread')
    .field('question', 'Updated question text.');
  expect(res.status).toBe(200);
  expect(tags()).toEqual(['threads-list', `thread-${thread._id}`].sort());
});

test('creating or deleting a thread refreshes the thread lists (forum landing + home) straight away', async () => {
  const owner = await createUser();
  const created = await api('post', '/api/threads/create', owner)
    .field('title', 'Fresh thread')
    .field('question', 'Hello')
    .field('category', 'General')
    .field('suburb', JSON.stringify({ name: 'Sydney', state: 'NSW', postalCode: '2000', location: { type: 'Point', coordinates: [151.2, -33.8] } }));
  expect(created.status).toBe(201);
  expect(tags()).toEqual(['threads-list']);

  calls = [];
  const del = await api('delete', `/api/threads/thread/${created.body._id}`, owner);
  expect(del.status).toBe(200);
  expect(tags()).toEqual(['threads-list', `thread-${created.body._id}`].sort());
});

test('editing a coupon campaign refreshes its page and the coupons list, and editing its store refreshes every campaign of the store', async () => {
  const admin = await createUser({ role: 'admin' });
  const store = await createStore(admin);
  const campaign = await createCampaign(store, admin);
  const other = await createCampaign(store, admin);

  const res = await api('put', `/api/admin/campaigns/${campaign._id}`, admin).send({ discount: '30% off' });
  expect(res.status).toBe(200);
  expect(tags()).toEqual([`campaign-${campaign.slug}`, 'coupons-list'].sort());

  calls = [];
  const storeRes = await api('put', `/api/admin/stores/${store._id}`, admin).field('storeName', 'Renamed Store');
  expect(storeRes.status).toBe(200);
  expect(tags()).toEqual([`campaign-${campaign.slug}`, `campaign-${other.slug}`, 'coupons-list'].sort());
});

test('creating and deleting a coupon campaign refreshes the coupons list', async () => {
  const admin = await createUser({ role: 'admin' });
  const store = await createStore(admin);

  const created = await api('post', `/api/admin/stores/${store._id}/campaigns`, admin).send({
    campaignName: 'Fresh Coupon', discount: '10% off', discountProduct: 'all items',
    expiryDate: new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString(),
  });
  expect(created.status).toBe(201);
  expect(tags()).toEqual(['coupons-list']);

  const inactive = await createCampaign(store, admin, { isActive: false });
  calls = [];
  const del = await api('delete', `/api/admin/campaigns/${inactive._id}`, admin);
  expect(del.status).toBe(200);
  expect(tags()).toEqual([`campaign-${inactive.slug}`, 'coupons-list'].sort());
});

test('editing a daily deal refreshes its page and the deals list, from the poster and from admin', async () => {
  const poster = await createUser();
  const admin = await createUser({ role: 'admin' });
  const partner = await createPartnerStore(poster);
  const deal = await createDeal(partner, poster);

  const res = await api('put', `/api/user/dailydeals/${deal._id}`, poster).field('dealTitle', 'Renamed Deal');
  expect(res.status).toBe(200);
  expect(tags()).toEqual([`deal-${deal._id}`, 'deals-list'].sort());

  calls = [];
  const adminRes = await api('put', `/api/admin/dailydeals/${deal._id}`, admin).field('dealTitle', 'Admin Renamed Deal');
  expect(adminRes.status).toBe(200);
  expect(tags()).toEqual([`deal-${deal._id}`, 'deals-list'].sort());
});

test('deleting a daily deal (poster or admin) refreshes its page and the deals list', async () => {
  const poster = await createUser();
  const admin = await createUser({ role: 'admin' });
  const partner = await createPartnerStore(poster);
  const deal = await createDeal(partner, poster);
  const other = await createDeal(partner, poster);

  const del = await api('delete', `/api/user/dailydeals/${deal._id}`, poster);
  expect(del.status).toBe(200);
  expect(tags()).toEqual([`deal-${deal._id}`, 'deals-list'].sort());

  calls = [];
  const adminDel = await api('delete', `/api/admin/dailydeals/${other._id}`, admin);
  expect(adminDel.status).toBe(200);
  expect(tags()).toEqual([`deal-${other._id}`, 'deals-list'].sort());
});

test('without a secret configured nothing is sent, and the edit still saves', async () => {
  delete process.env.REVALIDATION_SECRET;
  const organiser = await createOrganiser();
  const event = await createFreeEvent(organiser);

  const res = await updateFree(organiser, event._id, { title: 'Saved Without Refresh' });
  expect(res.status).toBe(200);
  expect(calls).toEqual([]);
});

test('without REVALIDATE_URL the first FRONTEND_URL entry (the CORS list) is used', async () => {
  const saved = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = `${process.env.REVALIDATE_URL}, https://www.example.test`;
  delete process.env.REVALIDATE_URL;
  try {
    const organiser = await createOrganiser();
    const event = await createFreeEvent(organiser);
    const res = await updateFree(organiser, event._id, { title: 'Refreshed Via Frontend Url' });
    expect(res.status).toBe(200);
    expect(tags()).toEqual(['events-list', `event-${event._id}`].sort());
  } finally {
    process.env.FRONTEND_URL = saved;
  }
});

test('an unreachable frontend does not fail the edit', async () => {
  process.env.REVALIDATE_URL = 'http://127.0.0.1:9'; // nothing listens on the discard port
  const organiser = await createOrganiser();
  const event = await createFreeEvent(organiser);

  const res = await updateFree(organiser, event._id, { title: 'Saved Despite Refresh Failure' });
  expect(res.status).toBe(200);
  expect(res.body.event.title).toBe('Saved Despite Refresh Failure');
});
