// Deleting and hiding events - see featureplans/events-delete-retention.md and events-past-events.md.
// An organiser "delete" is a soft delete (keeps the doc, image and registrations; a future event is
// cancelled). The admin permanent delete removes the event, its images, messages, waitlist and seat
// holds but KEEPS registrations, paid tickets, invoices and refund requests, and is refused for a
// future event with an unrefunded sale. A moderation hide (block) removes nothing and hides the event
// everywhere.
import Event from '../../models/eventModel.js';
import FreeTicket from '../../models/freeTicket.js';
import PaidTicket from '../../models/paidTicket.js';
import EventInvoice from '../../models/eventInvoice.js';
import RefundRequest from '../../models/refundRequest.js';
import WaitlistEntry from '../../models/waitlistEntry.js';
import Reservation from '../../models/reservationModel.js';
import Message from '../../models/messageModel.js';
import {
  createOrganiser,
  createUser,
  createFreeEvent,
  createPaidEvent,
  createFreeRegistration,
  createPaidTicket,
} from '../helpers/factories.js';
import { api, registerFree, reserve, byOrg, pastEventIds } from '../helpers/eventRequests.js';
import { daysAgo, ids } from '../helpers/dates.js';

const adminDelete = (event, admin) => api('delete', `/api/admin/events/byid/${event._id}`, admin);
const adminBlock = (event, admin) => api('patch', `/api/admin/events/${event._id}/block`, admin);
const organiserDelete = (event, organiser) => api('delete', `/api/events/${event._id}`, organiser);

describe('organiser delete', () => {
  test('an organiser delete is a soft delete: the event, its image and its registrations are kept', async () => {
    const org = await createOrganiser();
    const member = await createUser();
    const event = await createFreeEvent(org, { images: [{ url: 'http://img/x.jpg', publicId: 'pid-keep' }] });

    // A real registration, to prove the cascade does NOT run.
    const reg = await registerFree(event, member, { attendees: [{ name: 'A One' }] });
    expect(reg.status).toBeLessThan(400);
    expect(await FreeTicket.countDocuments({ event: event._id })).toBe(1);

    const del = await organiserDelete(event, org);
    expect(del.status).toBe(200);
    expect(del.body.softDeleted).toBe(true);

    const after = await Event.findById(event._id);
    expect(after).not.toBeNull();                       // the doc is kept
    expect(after.deletedByOrganiser).toBe(true);
    expect(after.images[0].publicId).toBe('pid-keep');  // the image is kept
    expect(await FreeTicket.countDocuments({ event: event._id })).toBe(1); // no cascade
  });

  test('deleting a future event cancels it: RSVP is refused and it leaves the organiser\'s upcoming list', async () => {
    const org = await createOrganiser({ slug: 'cancel-org' });
    const member = await createUser();
    const event = await createFreeEvent(org, {
      title: 'Cancel Me Fest',
      organizer: { name: 'Cancel Org', contact: '0412345678' },
    });

    // Before: it shows as upcoming on the organiser's public page.
    const before = await byOrg('cancel-org');
    expect(ids(before.body.events)).toContain(String(event._id));

    const del = await organiserDelete(event, org);
    expect(del.status).toBe(200);
    expect(del.body.cancelled).toBe(true);

    // RSVP is now refused.
    const rsvp = await registerFree(event, member, { attendees: [{ name: 'A One' }] });
    expect(rsvp.status).toBe(400);
    expect(rsvp.body.message).toMatch(/cancelled/i);

    // After: gone from upcoming.
    const after = await byOrg('cancel-org');
    expect(ids(after.body.events)).not.toContain(String(event._id));
  });
});

describe('admin permanent delete', () => {
  test('permanently deleting a past free event removes the event and its messages but keeps its RSVPs and their check-ins', async () => {
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

    const res = await adminDelete(event, admin);
    expect(res.status).toBe(200);

    expect(await Event.findById(event._id)).toBeNull();
    expect(await Message.countDocuments({ _id: msg._id })).toBe(0);

    const after = await FreeTicket.findById(reg._id);
    expect(after).not.toBeNull();
    expect(after.attendees[0].checkedIn).toBe(true);
  });

  test('permanently deleting an event keeps its paid tickets, invoices and refund requests', async () => {
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

    const res = await adminDelete(event, admin);
    expect(res.status).toBe(200);

    expect(await PaidTicket.countDocuments({ event: String(event._id) })).toBe(1);
    expect(await EventInvoice.collection.countDocuments({ event: String(event._id) })).toBe(1);
    expect(await RefundRequest.collection.countDocuments({ eventId: String(event._id) })).toBe(1);
  });

  test('permanently deleting a recurring event removes its waitlist entries and seat holds, including its children\'s', async () => {
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

    const res = await adminDelete(parent, admin);
    expect(res.status).toBe(200);

    expect(await Event.findById(child._id)).toBeNull(); // recurring child removed too
    expect(await WaitlistEntry.countDocuments({ event: { $in: [parent._id, child._id] } })).toBe(0);
    expect(await Reservation.countDocuments({ eventId: { $in: [parent._id, child._id] } })).toBe(0);
  });

  test('permanently deleting a future event with an unrefunded sold ticket is refused and the event survives', async () => {
    const org = await createOrganiser();
    const admin = await createUser({ role: 'admin' });
    const member = await createUser();
    const event = await createPaidEvent(org, { title: 'Future Sold Fest' }); // default dates are in the future
    await createPaidTicket(event, member, {});

    const res = await adminDelete(event, admin);
    expect(res.status).toBe(409);
    expect(await Event.findById(event._id)).not.toBeNull();
  });

  test('permanent delete is allowed once the sold ticket is fully refunded, and for a past event that had sales', async () => {
    const org = await createOrganiser();
    const admin = await createUser({ role: 'admin' });
    const member = await createUser();

    const futureEvent = await createPaidEvent(org, { title: 'Future Refunded Fest' });
    await createPaidTicket(futureEvent, member, { refundStatus: 'full' });
    const res1 = await adminDelete(futureEvent, admin);
    expect(res1.status).toBe(200);
    expect(await Event.findById(futureEvent._id)).toBeNull();

    const pastEvent = await createPaidEvent(org, {
      title: 'Past Sold Fest',
      dateTime: daysAgo(20),
      expiryDate: daysAgo(10),
    });
    await createPaidTicket(pastEvent, member, {});
    const res2 = await adminDelete(pastEvent, admin);
    expect(res2.status).toBe(200);
    expect(await Event.findById(pastEvent._id)).toBeNull();
  });
});

describe('admin purge queue', () => {
  test('an organiser-deleted past event sits in the purge queue and the Past strip until an admin purges it', async () => {
    const org = await createOrganiser();
    const admin = await createUser({ role: 'admin' });

    // A PAID past event the organiser soft-deleted, featured so it shows in the public Past strip.
    const paid = await createPaidEvent(org, {
      title: 'Purge Paid Fest', dateTime: daysAgo(6), expiryDate: daysAgo(2),
      images: [{ url: 'http://img/p.jpg', publicId: 'pid-purge' }],
      featuredInPast: true,
    });
    await organiserDelete(paid, org);

    // It sits in the admin purge queue and (being past) in the public Past list.
    const queue = await api('get', '/api/admin/events/purge-queue', admin);
    expect(queue.status).toBe(200);
    expect(ids(queue.body.events)).toContain(String(paid._id));
    expect(await pastEventIds()).toContain(String(paid._id));

    // Admin hard-delete: the doc is gone, and so is its Past strip entry. (What the purge keeps is
    // covered by the permanent-delete tests above.)
    const purge = await adminDelete(paid, admin);
    expect(purge.status).toBe(200);
    expect(await Event.findById(paid._id)).toBeNull();
    expect(await pastEventIds()).not.toContain(String(paid._id));
  });

  test('the purge queue lists blocked events as well as organiser-deleted ones, marked as which; a blocked event can be purged from it', async () => {
    const org = await createOrganiser();
    const admin = await createUser({ role: 'admin' });
    const member = await createUser();

    // A soft-deleted (organiser) event.
    const deletedEvent = await createFreeEvent(org, { title: 'Queue Deleted Fest' });
    await organiserDelete(deletedEvent, org);

    // A moderation-blocked event - past, so the sold-ticket guard does not apply.
    const blockedEvent = await createPaidEvent(org, {
      title: 'Queue Blocked Fest',
      dateTime: daysAgo(20),
      expiryDate: daysAgo(10),
    });
    await createPaidTicket(blockedEvent, member, {});
    await adminBlock(blockedEvent, admin);

    const queue = await api('get', '/api/admin/events/purge-queue', admin);
    expect(queue.status).toBe(200);
    const deletedRow = queue.body.events.find((e) => String(e._id) === String(deletedEvent._id));
    const blockedRow = queue.body.events.find((e) => String(e._id) === String(blockedEvent._id));
    expect(deletedRow?.deletedByOrganiser).toBe(true);
    expect(deletedRow?.isBlocked).toBe(false);
    expect(blockedRow?.isBlocked).toBe(true);
    expect(blockedRow?.deletedByOrganiser).toBe(false);

    // A permanent delete of the blocked (past) event from the queue succeeds.
    const purge = await adminDelete(blockedEvent, admin);
    expect(purge.status).toBe(200);
    expect(await Event.findById(blockedEvent._id)).toBeNull();
  });
});

describe('moderation hide (block)', () => {
  test('blocking an event records who and when and removes nothing, even for a future event with sales', async () => {
    const org = await createOrganiser();
    const admin = await createUser({ role: 'admin' });
    const member = await createUser();
    const event = await createPaidEvent(org, {
      title: 'Scam Future Fest',
      images: [{ url: 'http://img/scam.jpg', publicId: 'pid-scam' }],
    });
    await createPaidTicket(event, member, {}); // unrefunded sold ticket, future event

    const res = await adminBlock(event, admin);
    expect(res.status).toBe(200);

    const after = await Event.findById(event._id);
    expect(after).not.toBeNull();
    expect(after.isBlocked).toBe(true);
    expect(after.blockedAt).toBeTruthy();
    expect(String(after.blockedBy)).toBe(String(admin._id));
    expect(after.images.length).toBe(1);
    expect(await PaidTicket.countDocuments({ event: String(event._id) })).toBe(1);
  });

  test('a blocked event disappears from every public and organiser list, and RSVP and ticket purchase are refused', async () => {
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
      const blockRes = await adminBlock(ev, admin);
      expect(blockRes.status).toBe(200);
    }

    // Search
    const search = await api('get', '/api/events/search')
      .query({ filters: JSON.stringify({}), pagination: JSON.stringify({ page: 1, limit: 100 }) });
    expect(ids(search.body.events)).not.toContain(String(upcomingFree._id));

    // Discover/filter list
    const filterAll = await api('get', '/api/events/filters/all').query({ page: 1, limit: 100 });
    expect(ids(filterAll.body.events)).not.toContain(String(upcomingFree._id));

    // Home page
    const home = await api('get', '/api/home/events');
    expect(ids(home.body.data?.events || home.body.events)).not.toContain(String(upcomingFree._id));

    // Organiser public page
    const orgPage = await byOrg(org.slug);
    expect(ids(orgPage.body.events)).not.toContain(String(upcomingFree._id));

    // Organiser's own manage list
    const mine = await api('get', '/api/events/mine', org);
    expect(ids(mine.body)).not.toContain(String(upcomingFree._id));

    // Past strip (public)
    expect(await pastEventIds()).not.toContain(String(pastFeatured._id));

    // Admin past-curation list
    const curation = await api('get', '/api/admin/events/past-curation', admin);
    expect(ids(curation.body.events)).not.toContain(String(pastFeatured._id));

    // RSVP refused
    const rsvp = await registerFree(upcomingFree, member, { attendees: [{ name: 'A One' }] });
    expect(rsvp.status).toBe(400);

    // Ticket purchase (reservation create) refused
    const ticketTypeId = upcomingPaid.ticketTypes[0]._id.toString();
    const reservation = await reserve(member, upcomingPaid._id, [{ ticketTypeId, quantity: 1 }]);
    expect(reservation.status).toBe(400);
  });
});
