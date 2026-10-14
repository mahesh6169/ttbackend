import asyncHandler from 'express-async-handler';
import Event from '../../models/eventModel.js';
import User from '../../models/userModel.js';
import WaitlistEntry from '../../models/waitlistEntry.js';
import { verifyRecaptcha } from '../../utils/verifyRecaptcha.js';
import { calculateCurrentTicketsSold, isSalesOpen } from '../../utils/events/ticketHelpers.js';
import { calculateCurrentFreeRegistrations } from '../../utils/events/helperFreeEvent.js';
import { sendWaitlistAvailableEmail } from '../../utils/notifications/events/sendWaitlistNotification.js';

const WAITLIST_CAP = 500;

// @desc    Join an event's waitlist. Members join in one tap (session email); logged-out
//          visitors give an email (with the same bot defences as the guest fork) and a guest
//          record is created/reused. Public + optional auth. Server re-validates everything -
//          the browser state is advisory only. See featureplans/events-waitlist.md.
// @route   POST /api/events/:eventId/waitlist/join
// @access  Public (optional auth)
export const joinWaitlist = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const { email: bodyEmail, captchaToken, name: bodyName, mobile: bodyMobile } = req.body;

  const event = await Event.findById(eventId);
  if (!event) {
    return res.status(404).json({ success: false, message: 'Event not found' });
  }

  // --- Re-validation (advisory browser state is never trusted) ---
  // Promo / advertise-only events have no capacity and no waitlist.
  if (event.isAdvertiseOnly) {
    return res.status(400).json({ success: false, message: 'This event has no waitlist.' });
  }
  // Toggle must be ON.
  if (!event.waitlistEnabled) {
    return res.status(400).json({ success: false, message: 'The waitlist is not open for this event.' });
  }
  // Sales-closed wins over the waitlist: once the event day has passed, there is nothing
  // to wait for (D6). A paid event checks the ticket sales cutoff; free events use the same
  // logic because their free-RSVP window uses the same day-based rule.
  if (event.isPaid && !isSalesOpen(event)) {
    return res.status(400).json({ success: false, message: 'Ticket sales for this event have closed.', errorCode: 'SALES_CLOSED' });
  }
  // Event must actually be full (capacity 0 / unset = unlimited = never full).
  const capacity = event.capacity || 0;
  const sold = event.isPaid
    ? await calculateCurrentTicketsSold(event._id)
    : await calculateCurrentFreeRegistrations(event._id);
  if (capacity <= 0 || sold < capacity) {
    return res.status(400).json({ success: false, message: 'This event is not full.' });
  }
  // Abuse backstop.
  const count = await WaitlistEntry.countDocuments({ event: event._id });
  if (count >= WAITLIST_CAP) {
    return res.status(400).json({ success: false, message: 'The waitlist is full.' });
  }

  // --- Who is joining ---
  let email;
  let userId = null;
  let name = '';
  let mobile = '';
  if (req.user) {
    // Logged in (member or an active guest) - one tap, no bot defence needed.
    email = req.user.email;
    userId = req.user._id;
    // Snapshot the member's contact details ('Guest' is the guest placeholder, treat as blank).
    name = req.user.name && req.user.name !== 'Guest' ? req.user.name : '';
    mobile = req.user.mobile || '';
  } else {
    // Logged out - reCAPTCHA + email, then create/reuse a guest record (mirror guest attendance).
    if (!captchaToken) {
      return res.status(400).json({ success: false, message: 'reCAPTCHA token missing' });
    }
    try {
      await verifyRecaptcha(captchaToken);
    } catch (error) {
      return res.status(400).json({ success: false, message: 'reCAPTCHA verification failed' });
    }
    const normalisedEmail = typeof bodyEmail === 'string' ? bodyEmail.trim().toLowerCase() : '';
    if (!normalisedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalisedEmail)) {
      return res.status(400).json({ success: false, message: 'A valid email is required' });
    }
    // The waitlist is a low-stakes notification list, so ANY email may join without logging in
    // (unlike guest attendance, which blocks an existing-account email to avoid attaching a
    // registration/purchase to someone's account). Reuse the matching user record when one exists
    // (member or guest); otherwise create a guest record.
    const existing = await User.findOne({ email: normalisedEmail });
    const guestUser = existing || await User.create({ email: normalisedEmail, role: 'guest' });
    email = normalisedEmail;
    userId = guestUser._id;
    // Optional contact details from the form (capped; blank is fine).
    name = typeof bodyName === 'string' ? bodyName.trim().slice(0, 100) : '';
    mobile = typeof bodyMobile === 'string' ? bodyMobile.trim().slice(0, 30) : '';
  }

  // One entry per email per event; the unique index is the backstop for a race.
  try {
    await WaitlistEntry.create({ event: event._id, email, user: userId, name, mobile, notifiedAt: null });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(200).json({ success: true, alreadyJoined: true, message: 'You are on the waitlist.' });
    }
    throw err;
  }

  return res.status(201).json({ success: true, message: 'You are on the waitlist.' });
});

// @desc    List an event's waitlist entries in arrival order (oldest first) for the organiser.
//          Returns the event context (title/date/venue) plus each entry's name, email, joined
//          stamp and notified stamp, and the count still unnotified (drives the Send button).
// @route   GET /api/events/:eventId/waitlist/entries
// @access  Private (event owner only)
export const getEventWaitlist = asyncHandler(async (req, res) => {
  const { eventId } = req.params;

  const event = await Event.findById(eventId).select('title dateTime timeZone venue address postedBy');
  if (!event) {
    return res.status(404).json({ success: false, message: 'Event not found' });
  }
  if (event.postedBy.toString() !== req.user._id.toString()) {
    return res.status(403).json({ success: false, message: 'You are not authorised to view this waitlist.' });
  }

  const entries = await WaitlistEntry.find({ event: event._id })
    .populate('user', 'name')
    .sort({ createdAt: 1 }); // arrival order, oldest first

  // Prefer the name captured at join (entry snapshot); fall back to a known user name. A guest
  // record defaults name to 'Guest', so treat that (and blanks) as "name not known".
  const list = entries.map((e) => {
    const snapshotName = e.name && e.name.trim() ? e.name.trim() : null;
    const userName = e.user?.name && e.user.name.trim() && e.user.name.trim() !== 'Guest'
      ? e.user.name.trim()
      : null;
    return {
      _id: e._id,
      name: snapshotName || userName,
      mobile: e.mobile && e.mobile.trim() ? e.mobile.trim() : null,
      email: e.email,
      joinedAt: e.createdAt,
      notifiedAt: e.notifiedAt,
    };
  });
  const unnotifiedCount = list.filter((e) => !e.notifiedAt).length;

  return res.status(200).json({
    success: true,
    event: {
      _id: event._id,
      title: event.title,
      dateTime: event.dateTime,
      timeZone: event.timeZone,
      venue: event.venue,
    },
    entries: list,
    unnotifiedCount,
  });
});

// @desc    Email every not-yet-notified waitlist entry that tickets are available, one individual
//          email each, and stamp notifiedAt only on the ones that actually sent. Re-pressing later
//          reaches only people who joined since (target is notifiedAt == null). Manual only.
// @route   POST /api/events/:eventId/waitlist/notify
// @access  Private (event owner only)
export const sendWaitlistNotification = asyncHandler(async (req, res) => {
  const { eventId } = req.params;

  const event = await Event.findById(eventId);
  if (!event) {
    return res.status(404).json({ success: false, message: 'Event not found' });
  }
  if (event.postedBy.toString() !== req.user._id.toString()) {
    return res.status(403).json({ success: false, message: 'You are not authorised to send this notification.' });
  }

  const pending = await WaitlistEntry.find({ event: event._id, notifiedAt: null });
  if (pending.length === 0) {
    return res.status(200).json({ success: true, sent: 0, message: 'Everyone on the waitlist has already been notified.' });
  }

  // One individual email per entry; stamp notifiedAt only when the send succeeds so a failure is
  // simply picked up on the next manual send (v1 does not auto-retry).
  let sent = 0;
  for (const entry of pending) {
    const ok = await sendWaitlistAvailableEmail(event, entry.email);
    if (ok) {
      entry.notifiedAt = new Date();
      await entry.save();
      sent += 1;
    }
  }

  return res.status(200).json({
    success: true,
    sent,
    message: `Notified ${sent} ${sent === 1 ? 'person' : 'people'} that tickets are available.`,
  });
});
