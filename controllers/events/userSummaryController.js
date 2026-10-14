// controllers/events/userSummaryController.js
//
// Per-domain "what needs your attention" summary for the events domain.
// One endpoint, both event types (free + paid) and both perspectives
// (hosting + attending), merged by event and sorted soonest-first.
//
// Naming convention for future domains: GET /{resource}/user/summary
// (e.g. /listings/user/summary, /deals/user/summary). See ProfilePageUX.md.

import asyncHandler from 'express-async-handler';
import Event from '../../models/eventModel.js';
import FreeTicket from '../../models/freeTicket.js';
import PaidTicket from '../../models/paidTicket.js';

// @desc    Upcoming events for the logged-in user (hosting + attending, free + paid)
// @route   GET /api/events/user/summary
// @access  Private
export const getUserEventsSummary = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const now = new Date();

  // Live Event collection is the single source of truth for title / date / type.
  // `eventIntent: { $ne: 'promote' }` excludes promotional listings (no RSVP/ticket flow).
  const selectFields = '_id title dateTime timeZone isPaid';

  // 1) Events the user hosts (free + paid), upcoming only.
  const hostedEvents = await Event.find({
    postedBy: userId,
    eventIntent: { $ne: 'promote' },
    deletedByOrganiser: { $ne: true }, // hide organiser-cancelled events (events-past-events.md)
    isBlocked: { $ne: true }, // hide moderation-blocked events too (events-delete-retention.md D5)
    dateTime: { $gte: now },
  })
    .select(selectFields)
    .lean();

  // 2) Event ids the user attends (free RSVPs + paid tickets).
  const [freeAttIds, paidAttIds] = await Promise.all([
    FreeTicket.find({ user: userId }).distinct('event'),
    PaidTicket.find({ user: userId }).distinct('event'),
  ]);
  const attendedIds = [...new Set([...freeAttIds, ...paidAttIds].map(String))];

  // 3) Upcoming events the user attends (live docs for accurate title/date/type).
  const attendedEvents = attendedIds.length
    ? await Event.find({
        _id: { $in: attendedIds },
        eventIntent: { $ne: 'promote' },
        deletedByOrganiser: { $ne: true }, // hide organiser-cancelled events (events-past-events.md)
        isBlocked: { $ne: true }, // hide moderation-blocked events too (events-delete-retention.md D5)
        dateTime: { $gte: now },
      })
        .select(selectFields)
        .lean()
    : [];

  // 4) Merge by event id, attach roles. Same event hosted + attended → one entry.
  const byId = new Map();
  const upsert = (ev, role) => {
    const id = ev._id.toString();
    if (!byId.has(id)) {
      byId.set(id, {
        eventId: id,
        title: ev.title,
        dateTime: ev.dateTime,
        timeZone: ev.timeZone || 'Australia/Sydney',
        type: ev.isPaid ? 'paid' : 'free',
        roles: [],
      });
    }
    const item = byId.get(id);
    if (!item.roles.includes(role)) item.roles.push(role);
  };

  hostedEvents.forEach((ev) => upsert(ev, 'host'));
  attendedEvents.forEach((ev) => upsert(ev, 'attendee'));

  // 5) Soonest-first.
  const events = Array.from(byId.values()).sort(
    (a, b) => new Date(a.dateTime) - new Date(b.dateTime)
  );

  res.json({ events });
});
