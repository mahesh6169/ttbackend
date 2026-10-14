// events-past-events.md - Past events + organiser soft-delete + admin purge. Past is date-based (not the
// stale stored status); an organiser "delete" soft-deletes (keeps the doc + image, no cascade) and, for a
// future event, blocks buy/RSVP and drops it from upcoming; the admin purge queue is the only hard delete
// (frees the doc + images + FreeTickets, preserves PaidTickets + EventInvoices).
import request from 'supertest';
import app from '../app.js';
import Event from '../models/eventModel.js';
import FreeTicket from '../models/freeTicket.js';
import PaidTicket from '../models/paidTicket.js';
import EventInvoice from '../models/eventInvoice.js';
import { createOrganiser, createUser, createFreeEvent, createPaidEvent, cookieFor, API_KEY } from './helpers/factories.js';

const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000);
const ids = (list) => (list || []).map((e) => String(e._id));

test('AC2 the past query is by DATE among admin-featured events (stale-status past appears; future + unfeatured do not)', async () => {
  const org = await createOrganiser();
  // A FEATURED past event whose STORED status is a stale "active" (status is only recomputed on save).
  const past = await createFreeEvent(org, {
    title: 'Past Fest', status: 'active', dateTime: daysAgo(10), expiryDate: daysAgo(3), featuredInPast: true,
  });
  // A featured but FUTURE event - must not appear (it is not past).
  const future = await createFreeEvent(org, { title: 'Future Fest', featuredInPast: true });
  // A past event the admin has NOT featured - must not appear (curation).
  const unfeatured = await createFreeEvent(org, {
    title: 'Unfeatured Past Fest', dateTime: daysAgo(9), expiryDate: daysAgo(2),
  });

  const res = await request(app).get('/api/events/past').set('x-api-key', API_KEY);
  expect(res.status).toBe(200);
  expect(ids(res.body.events)).toContain(String(past._id));
  expect(ids(res.body.events)).not.toContain(String(future._id));
  expect(ids(res.body.events)).not.toContain(String(unfeatured._id)); // admin curation gate
});

test('AC7 admin curation toggles whether a past event shows in the public Past strip', async () => {
  const org = await createOrganiser();
  const admin = await createUser({ role: 'admin' });
  const past = await createFreeEvent(org, { title: 'Curate Me Fest', dateTime: daysAgo(8), expiryDate: daysAgo(3) });

  const inPast = async () => ids((await request(app).get('/api/events/past').set('x-api-key', API_KEY)).body.events);

  // Not featured -> absent.
  expect(await inPast()).not.toContain(String(past._id));

  // Admin features it -> appears.
  const on = await request(app)
    .patch(`/api/admin/events/${past._id}/past-featured`)
    .set('x-api-key', API_KEY).set('Cookie', cookieFor(admin))
    .send({ featured: true });
  expect(on.status).toBe(200);
  expect(on.body.featuredInPast).toBe(true);
  expect(await inPast()).toContain(String(past._id));

  // Admin unfeatures it -> disappears.
  const off = await request(app)
    .patch(`/api/admin/events/${past._id}/past-featured`)
    .set('x-api-key', API_KEY).set('Cookie', cookieFor(admin))
    .send({ featured: false });
  expect(off.status).toBe(200);
  expect(await inPast()).not.toContain(String(past._id));
});

test('AC3 an organiser delete SOFT-deletes: it keeps the doc + image and does NOT cascade', async () => {
  const org = await createOrganiser();
  const member = await createUser();
  const event = await createFreeEvent(org, { images: [{ url: 'http://img/x.jpg', publicId: 'pid-keep' }] });

  // A real registration, to prove the cascade does NOT run.
  const reg = await request(app)
    .post(`/api/events/${event._id}/free/register`)
    .set('x-api-key', API_KEY).set('Cookie', cookieFor(member))
    .send({ mobile: '0412345678', attendees: [{ name: 'A One' }] });
  expect(reg.status).toBeLessThan(400);
  expect(await FreeTicket.countDocuments({ event: event._id })).toBe(1);

  const del = await request(app)
    .delete(`/api/events/${event._id}`)
    .set('x-api-key', API_KEY).set('Cookie', cookieFor(org));
  expect(del.status).toBe(200);
  expect(del.body.softDeleted).toBe(true);

  const after = await Event.findById(event._id);
  expect(after).not.toBeNull();                       // the doc is kept
  expect(after.deletedByOrganiser).toBe(true);
  expect(after.images[0].publicId).toBe('pid-keep');  // the image is kept
  expect(await FreeTicket.countDocuments({ event: event._id })).toBe(1); // no cascade
});

test('AC5 deleting a FUTURE event blocks RSVP and drops it from the upcoming (organiser public) list', async () => {
  const org = await createOrganiser({ slug: 'cancel-org' });
  const member = await createUser();
  const event = await createFreeEvent(org, {
    title: 'Cancel Me Fest',
    organizer: { name: 'Cancel Org', contact: '0412345678' },
  });

  // Before: it shows as upcoming on the organiser's public page.
  const before = await request(app).get('/api/events/by/cancel-org').set('x-api-key', API_KEY);
  expect(ids(before.body.events)).toContain(String(event._id));

  const del = await request(app)
    .delete(`/api/events/${event._id}`)
    .set('x-api-key', API_KEY).set('Cookie', cookieFor(org));
  expect(del.status).toBe(200);
  expect(del.body.cancelled).toBe(true);

  // RSVP is now refused.
  const rsvp = await request(app)
    .post(`/api/events/${event._id}/free/register`)
    .set('x-api-key', API_KEY).set('Cookie', cookieFor(member))
    .send({ mobile: '0412345678', attendees: [{ name: 'A One' }] });
  expect(rsvp.status).toBe(400);
  expect(rsvp.body.message).toMatch(/cancelled/i);

  // After: gone from upcoming.
  const after = await request(app).get('/api/events/by/cancel-org').set('x-api-key', API_KEY);
  expect(ids(after.body.events)).not.toContain(String(event._id));
});

test('AC6 the admin purge queue lists soft-deleted events; a hard delete frees the doc but preserves FreeTickets, PaidTickets + EventInvoices (events-delete-retention.md D2)', async () => {
  const org = await createOrganiser();
  const admin = await createUser({ role: 'admin' });

  // A PAID past event the organiser soft-deleted, with a preserved ticket + invoice and an image.
  const paid = await createPaidEvent(org, {
    title: 'Purge Paid Fest', dateTime: daysAgo(6), expiryDate: daysAgo(2),
    images: [{ url: 'http://img/p.jpg', publicId: 'pid-purge' }],
    featuredInPast: true, // so it shows in the public Past strip before the purge
  });
  await PaidTicket.collection.insertOne({ event: String(paid._id) });
  await EventInvoice.collection.insertOne({ event: String(paid._id) });
  await request(app).delete(`/api/events/${paid._id}`).set('x-api-key', API_KEY).set('Cookie', cookieFor(org));

  // It sits in the admin purge queue and (being past) in the public Past list.
  const queue = await request(app)
    .get('/api/admin/events/purge-queue')
    .set('x-api-key', API_KEY).set('Cookie', cookieFor(admin));
  expect(queue.status).toBe(200);
  expect(ids(queue.body.events)).toContain(String(paid._id));
  const pastBefore = await request(app).get('/api/events/past').set('x-api-key', API_KEY);
  expect(ids(pastBefore.body.events)).toContain(String(paid._id));

  // Admin hard-delete.
  const purge = await request(app)
    .delete(`/api/admin/events/byid/${paid._id}`)
    .set('x-api-key', API_KEY).set('Cookie', cookieFor(admin));
  expect(purge.status).toBe(200);

  // Doc gone; financial records preserved; gone from Past.
  expect(await Event.findById(paid._id)).toBeNull();
  expect(await PaidTicket.collection.countDocuments({ event: String(paid._id) })).toBe(1);
  expect(await EventInvoice.collection.countDocuments({ event: String(paid._id) })).toBe(1);
  const pastAfter = await request(app).get('/api/events/past').set('x-api-key', API_KEY);
  expect(ids(pastAfter.body.events)).not.toContain(String(paid._id));

  // A FREE event's FreeTickets are RETAINED by the same admin hard-delete (events-delete-retention.md D2).
  const free = await createFreeEvent(org, { title: 'Purge Free Fest', dateTime: daysAgo(6), expiryDate: daysAgo(2) });
  await FreeTicket.collection.insertOne({ event: free._id });
  await request(app).delete(`/api/events/${free._id}`).set('x-api-key', API_KEY).set('Cookie', cookieFor(org));
  await request(app).delete(`/api/admin/events/byid/${free._id}`).set('x-api-key', API_KEY).set('Cookie', cookieFor(admin));
  expect(await Event.findById(free._id)).toBeNull();
  expect(await FreeTicket.collection.countDocuments({ event: free._id })).toBe(1);
});
