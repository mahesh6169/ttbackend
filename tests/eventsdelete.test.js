// featureplans/events-delete-retention.md
import request from 'supertest';
import app from '../app.js';
import Event from '../models/eventModel.js';
import FreeTicket from '../models/freeTicket.js';
import PaidTicket from '../models/paidTicket.js';
import EventInvoice from '../models/eventInvoice.js';
import RefundRequest from '../models/refundRequest.js';
import WaitlistEntry from '../models/waitlistEntry.js';
import Reservation from '../models/reservationModel.js';
import Message from '../models/messageModel.js';
import {
  createOrganiser,
  createUser,
  createFreeEvent,
  createPaidEvent,
  createFreeRegistration,
  createPaidTicket,
  cookieFor,
  API_KEY,
} from './helpers/factories.js';

const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000);
const ids = (list) => (list || []).map((e) => String(e._id));

// ---------------------------------------------------------------------------
// AC1: permanent delete of a past FREE event removes the event/images/messages, keeps RSVPs.
// ---------------------------------------------------------------------------
test('AC1 - permanent delete of a past free event removes the event, its images and messages but KEEPS its RSVP registrations, including check-in state', async () => {
  const org = await createOrganiser();
  const admin = await createUser({ role: 'admin' });
  const member = await createUser();
  const event = await createFreeEvent(org, {
    title: 'Past Retention Fest',
    dateTime: daysAgo(20),
    expiryDate: daysAgo(10),
    images: [{ url: 'http://img/x.jpg', publicId: 'pid-del' }],
  });
  const reg = await createFreeRegistration(event, member, {
    attendees: [{ name: 'A One', checkedIn: true, checkInTime: new Date() }],
  });
  const msg = await Message.create({
    relatedTo: 'event',
    event: event._id,
    owner: org._id,
    participant: member._id,
    senderRole: 'owner',
    message: 'hi',
  });

  const res = await request(app)
    .delete(`/api/admin/events/byid/${event._id}`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(admin));
  expect(res.status).toBe(200);

  expect(await Event.findById(event._id)).toBeNull();
  expect(await Message.countDocuments({ _id: msg._id })).toBe(0);

  const after = await FreeTicket.findById(reg._id);
  expect(after).not.toBeNull();
  expect(after.attendees[0].checkedIn).toBe(true);
});

// ---------------------------------------------------------------------------
// AC2: permanent delete keeps paid tickets, invoices and refund requests (regression guard).
// ---------------------------------------------------------------------------
test('AC2 - permanent delete keeps paid tickets, invoices and refund requests (regression guard)', async () => {
  const org = await createOrganiser();
  const admin = await createUser({ role: 'admin' });
  const member = await createUser();
  const event = await createPaidEvent(org, {
    title: 'Past Paid Retention Fest',
    dateTime: daysAgo(20),
    expiryDate: daysAgo(10),
  });
  const ticket = await createPaidTicket(event, member, {});
  await EventInvoice.collection.insertOne({ invoiceNumber: 'INV-RET-0001', event: String(event._id), user: member._id });
  await RefundRequest.collection.insertOne({ refundRequestId: 'REF-RET-0001', eventId: String(event._id), ticketNumbers: [ticket.ticketNumber], status: 'completed' });

  const res = await request(app)
    .delete(`/api/admin/events/byid/${event._id}`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(admin));
  expect(res.status).toBe(200);

  expect(await PaidTicket.countDocuments({ event: String(event._id) })).toBe(1);
  expect(await EventInvoice.collection.countDocuments({ event: String(event._id) })).toBe(1);
  expect(await RefundRequest.collection.countDocuments({ eventId: String(event._id) })).toBe(1);
});

// ---------------------------------------------------------------------------
// AC3: permanent delete removes waitlist entries and seat holds, including recurring children.
// ---------------------------------------------------------------------------
test('AC3 - permanent delete removes the event waitlist entries and seat holds, including those of recurring children', async () => {
  const org = await createOrganiser();
  const admin = await createUser({ role: 'admin' });
  const member1 = await createUser();
  const member2 = await createUser();
  const parent = await createFreeEvent(org, {
    title: 'Past Recurring Parent Fest',
    dateTime: daysAgo(20),
    expiryDate: daysAgo(10),
    recurrence: { isRecurring: true, parentEventId: null },
  });
  const child = await createFreeEvent(org, {
    title: 'Past Recurring Child Fest',
    dateTime: daysAgo(19),
    expiryDate: daysAgo(9),
    recurrence: { isRecurring: true, parentEventId: parent._id },
  });

  await WaitlistEntry.create({ event: parent._id, email: 'wl-parent@test.dev' });
  await WaitlistEntry.create({ event: child._id, email: 'wl-child@test.dev' });
  await Reservation.create({ userId: member1._id, sessionId: 'sess-parent', eventId: parent._id, seatIds: [], expiresAt: new Date(Date.now() + 3600000) });
  await Reservation.create({ userId: member2._id, sessionId: 'sess-child', eventId: child._id, seatIds: [], expiresAt: new Date(Date.now() + 3600000) });

  const res = await request(app)
    .delete(`/api/admin/events/byid/${parent._id}`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(admin));
  expect(res.status).toBe(200);

  expect(await Event.findById(child._id)).toBeNull(); // recurring child removed too (existing behaviour)
  expect(await WaitlistEntry.countDocuments({ event: { $in: [parent._id, child._id] } })).toBe(0);
  expect(await Reservation.countDocuments({ eventId: { $in: [parent._id, child._id] } })).toBe(0);
});

// ---------------------------------------------------------------------------
// AC4: permanent delete of a FUTURE event with an unrefunded sold ticket is refused.
// ---------------------------------------------------------------------------
test('AC4 - permanent delete of a FUTURE event with an unrefunded sold ticket is refused, and the event still exists', async () => {
  const org = await createOrganiser();
  const admin = await createUser({ role: 'admin' });
  const member = await createUser();
  const event = await createPaidEvent(org, { title: 'Future Sold Fest' }); // default dateTime/expiryDate are in the future
  await createPaidTicket(event, member, {});

  const res = await request(app)
    .delete(`/api/admin/events/byid/${event._id}`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(admin));
  expect(res.status).toBe(409);
  expect(await Event.findById(event._id)).not.toBeNull();
});

// ---------------------------------------------------------------------------
// AC5: the same delete succeeds once refunded, and succeeds for a PAST event with sold tickets.
// ---------------------------------------------------------------------------
test('AC5 - the same delete succeeds once that ticket is fully refunded, and succeeds for a PAST event that had sold tickets', async () => {
  const org = await createOrganiser();
  const admin = await createUser({ role: 'admin' });
  const member = await createUser();

  const futureEvent = await createPaidEvent(org, { title: 'Future Refunded Fest' });
  await createPaidTicket(futureEvent, member, { refundStatus: 'full' });
  const res1 = await request(app)
    .delete(`/api/admin/events/byid/${futureEvent._id}`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(admin));
  expect(res1.status).toBe(200);
  expect(await Event.findById(futureEvent._id)).toBeNull();

  const pastEvent = await createPaidEvent(org, {
    title: 'Past Sold Fest',
    dateTime: daysAgo(20),
    expiryDate: daysAgo(10),
  });
  await createPaidTicket(pastEvent, member, {});
  const res2 = await request(app)
    .delete(`/api/admin/events/byid/${pastEvent._id}`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(admin));
  expect(res2.status).toBe(200);
  expect(await Event.findById(pastEvent._id)).toBeNull();
});

// ---------------------------------------------------------------------------
// AC6: moderation hide marks the event blocked, removes nothing, allowed even for a future
// event with sold tickets.
// ---------------------------------------------------------------------------
test('AC6 - a moderation hide marks the event blocked with who and when, does NOT remove the event, its images or any registrations, and is allowed even for a future event with sold tickets', async () => {
  const org = await createOrganiser();
  const admin = await createUser({ role: 'admin' });
  const member = await createUser();
  const event = await createPaidEvent(org, {
    title: 'Scam Future Fest',
    images: [{ url: 'http://img/scam.jpg', publicId: 'pid-scam' }],
  });
  await createPaidTicket(event, member, {}); // unrefunded sold ticket, future event

  const res = await request(app)
    .patch(`/api/admin/events/${event._id}/block`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(admin));
  expect(res.status).toBe(200);

  const after = await Event.findById(event._id);
  expect(after).not.toBeNull();
  expect(after.isBlocked).toBe(true);
  expect(after.blockedAt).toBeTruthy();
  expect(String(after.blockedBy)).toBe(String(admin._id));
  expect(after.images.length).toBe(1);
  expect(await PaidTicket.countDocuments({ event: String(event._id) })).toBe(1);
});

// ---------------------------------------------------------------------------
// AC7: a blocked event is absent everywhere public/organiser-facing; RSVP and purchase refused.
// ---------------------------------------------------------------------------
test('AC7 - a blocked event is absent from search, discover/filter lists, home, the organiser public page, the manage list, the Past strip and the past-curation list; RSVP and ticket purchase are refused', async () => {
  const org = await createOrganiser({ slug: `blocked-org-${Date.now()}` });
  const admin = await createUser({ role: 'admin' });
  const member = await createUser();

  const upcomingFree = await createFreeEvent(org, {
    title: 'Blocked Upcoming Fest',
    organizer: { name: 'Org', contact: '0412345678' },
  });
  const upcomingPaid = await createPaidEvent(org, { title: 'Blocked Upcoming Paid Fest' });
  const pastFeatured = await createPaidEvent(org, {
    title: 'Blocked Past Fest',
    dateTime: daysAgo(20),
    expiryDate: daysAgo(10),
    featuredInPast: true,
  });

  for (const ev of [upcomingFree, upcomingPaid, pastFeatured]) {
    const blockRes = await request(app)
      .patch(`/api/admin/events/${ev._id}/block`)
      .set('x-api-key', API_KEY)
      .set('Cookie', cookieFor(admin));
    expect(blockRes.status).toBe(200);
  }

  // Search
  const search = await request(app)
    .get('/api/events/search')
    .query({ filters: JSON.stringify({}), pagination: JSON.stringify({ page: 1, limit: 100 }) })
    .set('x-api-key', API_KEY);
  expect(ids(search.body.events)).not.toContain(String(upcomingFree._id));

  // Discover/filter list
  const filterAll = await request(app)
    .get('/api/events/filters/all')
    .query({ page: 1, limit: 100 })
    .set('x-api-key', API_KEY);
  expect(ids(filterAll.body.events)).not.toContain(String(upcomingFree._id));

  // Home page
  const home = await request(app).get('/api/home/events').set('x-api-key', API_KEY);
  expect(ids(home.body.data?.events || home.body.events)).not.toContain(String(upcomingFree._id));

  // Organiser public page
  const orgPage = await request(app).get(`/api/events/by/${org.slug}`).set('x-api-key', API_KEY);
  expect(ids(orgPage.body.events)).not.toContain(String(upcomingFree._id));

  // Organiser's own manage list
  const mine = await request(app).get('/api/events/mine').set('x-api-key', API_KEY).set('Cookie', cookieFor(org));
  expect(ids(mine.body)).not.toContain(String(upcomingFree._id));

  // Past strip (public)
  const pastStrip = await request(app).get('/api/events/past').set('x-api-key', API_KEY);
  expect(ids(pastStrip.body.events)).not.toContain(String(pastFeatured._id));

  // Admin past-curation list
  const curation = await request(app)
    .get('/api/admin/events/past-curation')
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(admin));
  expect(ids(curation.body.events)).not.toContain(String(pastFeatured._id));

  // RSVP refused
  const rsvp = await request(app)
    .post(`/api/events/${upcomingFree._id}/free/register`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(member))
    .send({ mobile: '0412345678', attendees: [{ name: 'A One' }] });
  expect(rsvp.status).toBe(400);

  // Ticket purchase (reservation create) refused
  const ticketTypeId = upcomingPaid.ticketTypes[0]._id.toString();
  const reservation = await request(app)
    .post(`/api/events/${upcomingPaid._id}/reservation`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(member))
    .send({ tickets: [{ ticketTypeId, quantity: 1 }] });
  expect(reservation.status).toBe(400);
});

// ---------------------------------------------------------------------------
// AC8: purge queue lists blocked events alongside organiser-deleted ones; delete from queue works.
// ---------------------------------------------------------------------------
test('AC8 - the purge queue lists blocked events as well as organiser-deleted ones, each marked with which it is; a permanent delete from the queue then removes a blocked event', async () => {
  const org = await createOrganiser();
  const admin = await createUser({ role: 'admin' });
  const member = await createUser();

  // A soft-deleted (organiser) past event.
  const deletedEvent = await createFreeEvent(org, { title: 'Queue Deleted Fest' });
  await request(app)
    .delete(`/api/events/${deletedEvent._id}`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(org));

  // A moderation-blocked event - past, so the sold-ticket guard does not apply.
  const blockedEvent = await createPaidEvent(org, {
    title: 'Queue Blocked Fest',
    dateTime: daysAgo(20),
    expiryDate: daysAgo(10),
  });
  await createPaidTicket(blockedEvent, member, {});
  await request(app)
    .patch(`/api/admin/events/${blockedEvent._id}/block`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(admin));

  const queue = await request(app)
    .get('/api/admin/events/purge-queue')
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(admin));
  expect(queue.status).toBe(200);
  const deletedRow = queue.body.events.find((e) => String(e._id) === String(deletedEvent._id));
  const blockedRow = queue.body.events.find((e) => String(e._id) === String(blockedEvent._id));
  expect(deletedRow?.deletedByOrganiser).toBe(true);
  expect(deletedRow?.isBlocked).toBe(false);
  expect(blockedRow?.isBlocked).toBe(true);
  expect(blockedRow?.deletedByOrganiser).toBe(false);

  // A permanent delete of the blocked (past) event from the queue succeeds.
  const purge = await request(app)
    .delete(`/api/admin/events/byid/${blockedEvent._id}`)
    .set('x-api-key', API_KEY)
    .set('Cookie', cookieFor(admin));
  expect(purge.status).toBe(200);
  expect(await Event.findById(blockedEvent._id)).toBeNull();
});
