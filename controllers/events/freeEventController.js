// controllers/events/freeEventController.js

import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import Event from '../../models/eventModel.js';
import FreeTicket from '../../models/freeTicket.js';
import { generateRegistrationNumber, createFreeEventSnapshot, calculateCurrentFreeRegistrations } from '../../utils/events/helperFreeEvent.js';
import { validateRegistrationAnswers } from '../../utils/events/registrationFieldValidation.js';
import { displayLabelForAnswer } from '../../utils/events/answerMatching.js';
import { sendRegistrationConfirmationToAttendee, sendRegistrationNotificationToOrganizer, sendCancellationConfirmation } from '../../utils/notifications/events/sendEventRegistrationNotifications.js';
import { isSalesOpen } from '../../utils/events/ticketHelpers.js';

// @desc    Register for a free event
// @route   POST /api/events/:eventId/register-free
// @access  Private
export const registerForFreeEvent = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const { attendees, formResponses, mobile } = req.body; // ✅ ADD formResponses
  const userId = req.user._id;
  const userEmail = req.user.email;

  console.log("🎫 Free event registration request:", { eventId, userId, attendeesCount: attendees?.length });

  // ✅ For new registrations, we still need the event from Event schema
  // This is acceptable because registrations happen when events are active
  const event = await Event.findById(eventId).populate('postedBy', 'email name');
  if (!event) {
    return res.status(404).json({ 
      success: false, 
      message: 'Event not found' 
    });
  }

  // ✅ Check if event is free
  if (event.isPaid) {
    return res.status(400).json({
      success: false,
      message: 'This is a paid event. Use payment registration instead.'
    });
  }

  // 🚫 Organiser-cancelled (soft-deleted) event: RSVP is closed (events-past-events.md D4).
  if (event.deletedByOrganiser) {
    return res.status(400).json({
      success: false,
      message: 'This event has been cancelled by the organiser and is no longer accepting registrations.'
    });
  }

  // 🚫 Moderation-blocked event: not bookable (events-delete-retention.md D5/AC7).
  if (event.isBlocked) {
    return res.status(400).json({
      success: false,
      message: 'This event is no longer available.'
    });
  }

  // 🚫 Registration closes at the same cutoff paid sales use - end of the event day in the
  // event's own timezone, via the shared sales-window helper (events-past-offline-curation.md D6/D7).
  if (!isSalesOpen(event)) {
    return res.status(400).json({
      success: false,
      message: 'Registrations for this event have closed.',
      errorCode: 'REGISTRATION_CLOSED',
    });
  }

  // 🚧 Registration answer wall (events-rsvp-question-types.md D11): re-derived from the event's OWN
  // questions, so the client cannot bypass it. Enforces required answers of every type, each answer's
  // shape, and blocking (events-rsvp-blocking-questions.md). Returns the cleaned answers to store.
  const answerCheck = validateRegistrationAnswers(event.registrationFields, formResponses);
  if (!answerCheck.ok) {
    return res.status(400).json({ success: false, message: answerCheck.message });
  }
  const cleanedFormResponses = answerCheck.answers;

  // ✅ Check if user already registered
  const existingRegistration = await FreeTicket.findOne({ 
    event: eventId, 
    user: userId 
  });

  if (existingRegistration) {
    return res.status(400).json({ 
      success: false, 
      message: 'You are already registered for this event',
      registrationNumber: existingRegistration.registrationNumber
    });
  }

  // ✅ Validate mobile number
  if (!mobile || !mobile.trim()) {
    return res.status(400).json({ 
      success: false, 
      message: 'Mobile number is required' 
    });
  }

  // ✅ Validate attendees input
  if (!attendees || !Array.isArray(attendees) || attendees.length === 0) {
    return res.status(400).json({ 
      success: false, 
      message: 'At least one attendee is required' 
    });
  }

  // ✅ Validate attendee names
  for (let i = 0; i < attendees.length; i++) {
    const attendee = attendees[i];
    if (!attendee.name || !attendee.name.trim()) {
      return res.status(400).json({ 
        success: false, 
        message: `Attendee ${i + 1} name is required` 
      });
    }
  }

  // ✅ Check max attendees per registration limit
  if (attendees.length > event.maxAttendeesPerRegistration) {
    return res.status(400).json({ 
      success: false, 
      message: `Maximum ${event.maxAttendeesPerRegistration} attendees allowed per registration` 
    });
  }

    // ✅ Check event capacity (if limited)
  if (event.capacity && event.capacity > 0) {
    const currentRegistrations = await calculateCurrentFreeRegistrations(eventId);
    const newAttendeesCount = attendees.length;
    
    if (currentRegistrations + newAttendeesCount > event.capacity) {
      const remainingCapacity = event.capacity - currentRegistrations;
      
      // Better error messages based on remaining capacity
      let message;
      if (remainingCapacity === 0) {
        message = 'Sorry, this event just filled up! The last spot was taken moments ago. Please check back later for any cancellations.';
      } else if (remainingCapacity < 0) {
        // This shouldn't happen but just in case
        message = 'This event is now over capacity. Please try again later.';
      } else if (remainingCapacity === 1) {
        message = `Only 1 spot remaining, but you are trying to register ${newAttendeesCount} attendees. Please reduce your selection.`;
      } else {
        message = `Only ${remainingCapacity} spots remaining. You are trying to register ${newAttendeesCount} attendees. Please reduce your selection.`;
      }
      
      return res.status(400).json({ 
        success: false, 
        message
      });
    }
    
    console.log(`📊 Capacity check passed: ${currentRegistrations + newAttendeesCount}/${event.capacity} after registration`);
  }

  // ✅ Generate unique registration number
const registrationNumber = await generateRegistrationNumber(event.eventCode);

// ✅ Create event snapshot for ticket independence
const eventSnapshot = createFreeEventSnapshot(event);

  try {
    // ✅ Create registration
    const registration = await FreeTicket.create({
      event: eventId,
      registrationNumber,
       eventSnapshot, 
      user: userId,
      email: userEmail,
      mobile: mobile.trim(),
      attendees: attendees.map(attendee => ({
        name: attendee.name.trim(),
        checkedIn: false
      })),
      formResponses: cleanedFormResponses, // cleaned + shape-validated by the answer wall
      status: 'registered'
    });

    // Edit-locking signal (events-edit-locking.md D4): the first RSVP marks the event active so
    // the edit wizard can lock activity-bound fields. Only-flip-on, non-blocking.
    try {
      await Event.updateOne({ _id: eventId, hasActivity: { $ne: true } }, { $set: { hasActivity: true } });
    } catch (flagErr) {
      console.warn('Could not set hasActivity on free registration:', flagErr?.message);
    }

    // ✅ Populate for response
    await registration.populate('event', 'title dateTime venue');
    await registration.populate('user', 'name email');

    console.log("✅ Registration created successfully:", registration.registrationNumber);

    // Send email notifications
    try {
      // Send confirmation to attendee
      await sendRegistrationConfirmationToAttendee({ 
        registration, 
        event 
      });

      // Send notification to event organizer
      if (event.postedBy?.email) {
        await sendRegistrationNotificationToOrganizer({ 
          registration: {
            ...registration.toObject(),
            user: req.user // Include user info
          }, 
          event,
          organizerEmail: event.postedBy.email
        });
      }
    } catch (emailError) {
      console.warn("⚠️ Email notification failed:", emailError.message);
      // Don't fail the registration if email fails
    }

   res.status(201).json({
  success: true,
  message: 'Registration successful!',
  registration: {
    registrationNumber: registration.registrationNumber,
    event: {
      title: registration.eventSnapshot.title,
      dateTime: registration.eventSnapshot.dateTime,
      venue: registration.eventSnapshot.venue
    },
    attendees: registration.attendees.map(att => ({
      name: att.name,
    })),
    status: registration.status,
    createdAt: registration.createdAt
  }
});

  } catch (error) {
    console.error('❌ Registration creation failed:', error);
    res.status(500).json({
      success: false,
      message: 'Registration failed. Please try again.'
    });
  }
});


// @desc    Unregister from a free event
// @route   DELETE /api/events/:eventId/unregister-free
// @access  Private
// Shared cancellation path used by both self-unregister and organiser cancel:
// snapshot the registration, delete it (which frees capacity), then send the existing
// cancellation email to the registrant and the organiser. Email failures never block
// the cancellation.
const cancelFreeRegistration = async ({ registration, event, attendeeEmail }) => {
  const registrationData = registration.toObject();
  await registration.deleteOne();
  try {
    await sendCancellationConfirmation({
      registration: registrationData,
      event,
      attendeeEmail,
      organizerEmail: event?.postedBy?.email
    });
  } catch (emailError) {
    console.warn("⚠️ Cancellation email notification failed:", emailError.message);
    // Don't fail the cancellation if email fails
  }
};

export const unregisterFromFreeEvent = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const userId = req.user._id;

  console.log(`🗑️ Unregister request for event: ${eventId}, user: ${userId}`);

  // Find the registration
  const registration = await FreeTicket.findOne({ event: eventId, user: userId });

  if (!registration) {
    return res.status(404).json({
      success: false,
      message: 'No registration found for this event and user.'
    });
  }

  // Get event details for email
  const event = await Event.findById(eventId).populate('postedBy', 'email name');

  await cancelFreeRegistration({ registration, event, attendeeEmail: req.user.email });

  console.log(`✅ Registration deleted for event: ${eventId}, user: ${userId}`);

  res.json({
    success: true,
    message: 'You have been unregistered from the event.'
  });
});

// @desc    Organiser cancels a registration (guest or member) from the free check-in console.
//          Guests cannot self-cancel, so the organiser closes that loop; members phone in too.
// @route   DELETE /api/events/:eventId/free/registration/:ticketId
// @access  Private (event organiser only)
export const cancelRegistrationByOrganiser = asyncHandler(async (req, res) => {
  const { eventId, ticketId } = req.params;
  const userId = req.user._id;

  const registration = await FreeTicket.findOne({ _id: ticketId, event: eventId })
    .populate('user', 'email name');

  if (!registration) {
    res.status(404);
    throw new Error('Registration not found');
  }

  // Authorise by event ownership - same check the check-in endpoints use.
  if (registration.eventSnapshot?.postedBy !== userId.toString()) {
    res.status(403);
    throw new Error('Not authorized to cancel registrations for this event');
  }

  // Mirror the self-cancel rule: a registration with anyone already checked in cannot be cancelled.
  if (registration.attendees.some(a => a.checkedIn)) {
    res.status(409);
    throw new Error('This registration has a checked-in attendee and cannot be cancelled');
  }

  const event = await Event.findById(eventId).populate('postedBy', 'email name');
  const attendeeEmail = registration.email || registration.user?.email;

  await cancelFreeRegistration({ registration, event, attendeeEmail });

  console.log(`✅ Organiser ${userId} cancelled registration ${ticketId} for event ${eventId}`);

  res.json({
    success: true,
    message: 'Registration cancelled',
    ticketId
  });
});


// @desc    Check current user's registration status for a free event
// @route   GET /api/events/:eventId/registration-status
// @access  Private
export const getFreeEventRegistrationStatus = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const userId = req.user._id;

  const registration = await FreeTicket.findOne({ event: eventId, user: userId });

  if (!registration) {
    return res.json({
      success: true,
      registered: false,
      registration: null
    });
  }

  res.json({
    success: true,
    registered: true,
    registration
  });
});

// @desc    Fetch all free event registrations for the logged-in user
// @route   GET /api/events/my-free-registrations
// @access  Private
export const fetchMyFreeRegistrations = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  let filter = { user: userId };
  if (req.query.eventIds) {
    const eventIdsArray = req.query.eventIds.split(',').map(id => id.trim());
    filter.event = { $in: eventIdsArray };
  }

  const registrations = await FreeTicket.find(filter)
  .populate('user', 'name email');

res.json({
  success: true,
  registrations
});
});





// PATCH /events/:eventId/free/checkin/:ticketId
export const checkinFreeEvent = asyncHandler(async (req, res) => {
  const { eventId, ticketId } = req.params;
  const { attendeeId } = req.body; // attendeeId sent in the request body
  const userId = req.user._id;

  // 1. Find the ticket and verify authorization using eventSnapshot
  const ticket = await FreeTicket.findOne({ _id: ticketId, event: eventId });
  if (!ticket) {
    res.status(404);
    throw new Error('Ticket not found');
  }

  // Check if user is the organizer using eventSnapshot
  if (ticket.eventSnapshot?.postedBy !== userId.toString()) {
    res.status(403);
    throw new Error('Not authorized to check in attendees for this event');
  }

  // 3. Find the specific attendee
  const attendee = ticket.attendees.id(attendeeId);
  if (!attendee) {
    res.status(404);
    throw new Error('Attendee not found');
  }

  if (attendee.checkedIn) {
    return res.json({ success: false, message: 'Already checked in', ticket });
  }

  // 4. Mark the attendee as checked in
  attendee.checkedIn = true;
  attendee.checkInTime = new Date();

  // 5. Optionally update ticket.status if all attendees are checked in
  if (ticket.attendees.every(a => a.checkedIn)) {
    ticket.status = 'checkedin';
  }

  await ticket.save();

  res.json({ success: true, message: 'Attendee checked in', ticket });
});


// PATCH /events/:eventId/free/undo-checkin/:ticketId
export const undoCheckinFreeEvent = asyncHandler(async (req, res) => {
  const { eventId, ticketId } = req.params;
  const { attendeeId } = req.body;
  const userId = req.user._id;

  // 1. Find the ticket and verify authorization using eventSnapshot
  const ticket = await FreeTicket.findOne({ _id: ticketId, event: eventId });
  if (!ticket) {
    res.status(404);
    throw new Error('Ticket not found');
  }

  // Check if user is the organizer using eventSnapshot
  if (ticket.eventSnapshot?.postedBy !== userId.toString()) {
    res.status(403);
    throw new Error('Not authorized to undo check-in');
  }

  // 3. Find the specific attendee
  const attendee = ticket.attendees.id(attendeeId);
  if (!attendee) {
    res.status(404);
    throw new Error('Attendee not found');
  }

  if (!attendee.checkedIn) {
    return res.json({ success: false, message: 'Attendee is not checked in', ticket });
  }

  // 4. Undo check-in
  attendee.checkedIn = false;
  attendee.checkInTime = null;

  // 5. Optionally update ticket.status if any attendee is now not checked in
  if (ticket.attendees.some(a => !a.checkedIn)) {
    ticket.status = 'registered';
  }

  await ticket.save();

  res.json({ success: true, message: 'Attendee check-in undone', ticket });
});

// @desc    Get all attendees for check-in page (with user details)
// @route   GET /api/events/:eventId/free/attendees
// @access  Private (organiser only)
export const getEventAttendeesForCheckIn = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const userId = req.user._id;
  
  // Extract pagination and search parameters
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const search = req.query.search || '';
  const skip = (page - 1) * limit;

  // 1. Authorize: user must be the event organiser.
  //    - FreeTicket eventSnapshot path covers events that may have been deleted
  //      but still have registrations.
  //    - Event.postedBy fallback covers events with zero registrations (no
  //      FreeTicket exists yet) — the dropdown lists these too, so the check-in
  //      page must not 403 when an organiser opens one.
  const sampleTicket = await FreeTicket.findOne({
    event: eventId,
    'eventSnapshot.postedBy': userId.toString()
  });

  let isOrganiser = !!sampleTicket;
  if (!isOrganiser) {
    const event = await Event.findById(eventId).select('postedBy').lean();
    isOrganiser = !!(event && event.postedBy && event.postedBy.toString() === userId.toString());
  }

  if (!isOrganiser) {
    res.status(403);
    throw new Error('You are not authorised to manage this event\'s attendees');
  }

  // 2. Build search query
  const query = { event: eventId };

  if (search) {
    const searchRegex = new RegExp(search, 'i');
    query.$or = [
      { registrationNumber: searchRegex },
      { email: searchRegex },
      { 'attendees.name': searchRegex },
      { 'formResponses.response': searchRegex }
    ];
  }

  // Optional check-in status filter, so the All / Pending / Done tabs pull their own bookings from
  // the WHOLE event (not just the loaded page) - needed once the console pages with "Load more".
  //   done    = every attendee checked in (no attendee left un-checked)
  //   pending = at least one attendee not checked in (un-checked or partly-checked)
  const status = req.query.status;
  if (status === 'done') {
    query.attendees = { $not: { $elemMatch: { checkedIn: false } } };
  } else if (status === 'pending') {
    query.attendees = { $elemMatch: { checkedIn: false } };
  }

  // 3. Get total count for pagination (respects search + status filter)
  const totalCount = await FreeTicket.countDocuments(query);

  // 4. Find registrations with pagination and search
  const registrationDocs = await FreeTicket.find(query)
    .populate('user', 'name email phone')
    // Sort by createdAt then _id: _id is the unique tiebreaker so paging is STABLE - without it,
    // rows sharing a createdAt (e.g. concurrent RSVPs) order non-deterministically and skip/limit
    // pages overlap, which duplicates rows across "Load more" pages.
    .sort({ createdAt: -1, _id: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  // Relabel each answer to its question's CURRENT label by id (events-rsvp-question-editing.md D3/D7),
  // so every check-in display and the CSV show the current wording; old answers with no id (or an
  // unmatched one) keep the label they were stored under. Non-destructive - the DB is untouched.
  const eventQuestions = (await Event.findById(eventId).select('registrationFields').lean())?.registrationFields || [];
  const registrations = registrationDocs.map((reg) => ({
    ...reg,
    formResponses: (reg.formResponses || []).map((a) => ({
      ...a,
      fieldName: displayLabelForAnswer(a, eventQuestions),
    })),
  }));

  // 5. Pagination metadata
  const totalPages = Math.ceil(totalCount / limit);
  const hasNextPage = page < totalPages;
  const hasPrevPage = page > 1;

  // 6. Event-wide stats (whole event, independent of the page / search / status filter) so the
  //    Registrations / Attendees / Checked In strip stays accurate no matter how much is loaded.
  const statsAgg = await FreeTicket.aggregate([
    { $match: { event: new mongoose.Types.ObjectId(eventId) } },
    {
      $project: {
        attendeeCount: { $size: '$attendees' },
        checkedInCount: { $size: { $filter: { input: '$attendees', as: 'a', cond: '$$a.checkedIn' } } },
      },
    },
    {
      $group: {
        _id: null,
        totalRegistrations: { $sum: 1 },
        totalAttendees: { $sum: '$attendeeCount' },
        checkedInAttendees: { $sum: '$checkedInCount' },
      },
    },
  ]);
  const stats = statsAgg[0]
    ? { totalRegistrations: statsAgg[0].totalRegistrations, totalAttendees: statsAgg[0].totalAttendees, checkedInAttendees: statsAgg[0].checkedInAttendees }
    : { totalRegistrations: 0, totalAttendees: 0, checkedInAttendees: 0 };

  // 7. Return paginated results + event-wide stats. registrationFields (the CURRENT questions, with
  // ids + labels) lets the CSV build one column per question by id, headed by the current label.
  res.json({
    success: true,
    registrations,
    registrationFields: eventQuestions,
    stats,
    pagination: {
      currentPage: page,
      totalPages,
      totalCount,
      limit,
      hasNextPage,
      hasPrevPage
    }
  });
});

// @desc    Get user's managed free events (live Event docs ∪ FreeTicket snapshots)
// @route   GET /api/events/user/managed/free
// @access  Private
//
// Sources unioned so events appear immediately on creation (zero registrations)
// AND events deleted from the Event collection but still having registrations
// remain reachable for check-in:
//   Source 1 — Event collection: free, non-promotional events owned by the user.
//              Covers brand-new events that have no FreeTicket yet.
//   Source 2 — FreeTicket eventSnapshots: covers events that may have been
//              hard-deleted (eventController.js:943) but still have registrations.
// Live Event data wins on key collision (fresher than snapshot).
export const getUserManagedFreeEvents = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  console.log('🔍 [getUserManagedFreeEvents] Fetching managed free events for user:', {
    userId: userId.toString(),
    userEmail: req.user.email,
    userName: req.user.name
  });

  // Source 1: live free events the user owns. `$ne: true` (not `false`) so legacy
  // docs without an explicit isPaid field are still treated as free. `$ne: 'promote'`
  // excludes promotional listings, which have no RSVP flow.
  const liveEvents = await Event.find({
    postedBy: userId,
    isPaid: { $ne: true },
    eventIntent: { $ne: 'promote' }
  })
    .select('_id title venue dateTime capacity address eventCode timeZone organizer registrationFields')
    .lean();

  console.log(`📊 [getUserManagedFreeEvents] Live Event docs: ${liveEvents.length}`);

  // Source 2: FreeTicket snapshots — preserved so deleted-but-registered events
  // remain reachable for check-in.
  const tickets = await FreeTicket.find({
    'eventSnapshot.postedBy': userId.toString()
  })
    .select('event eventSnapshot')
    .lean();

  console.log(`📊 [getUserManagedFreeEvents] FreeTicket snapshots: ${tickets.length}`);

  const eventMap = new Map();

  for (const ev of liveEvents) {
    eventMap.set(ev._id.toString(), {
      _id: ev._id.toString(),
      title: ev.title,
      venue: ev.venue,
      dateTime: ev.dateTime,
      capacity: ev.capacity || 0,
      address: ev.address,
      eventCode: ev.eventCode,
      timeZone: ev.timeZone || 'Australia/Sydney',
      organizer: ev.organizer,
      // Carried so the check-in list card's CSV export can build one column per question in
      // builder order (events-rsvp-question-types.md D12).
      registrationFields: ev.registrationFields || []
    });
  }

  for (const ticket of tickets) {
    const eventId = ticket.event.toString();
    if (eventMap.has(eventId) || !ticket.eventSnapshot) continue;
    eventMap.set(eventId, {
      _id: eventId,
      title: ticket.eventSnapshot.title,
      venue: ticket.eventSnapshot.venue,
      dateTime: ticket.eventSnapshot.dateTime,
      capacity: ticket.eventSnapshot.capacity || 0,
      address: ticket.eventSnapshot.address,
      eventCode: ticket.eventSnapshot.eventCode,
      timeZone: ticket.eventSnapshot.timeZone || 'Australia/Sydney',
      organizer: ticket.eventSnapshot.organizer
    });
  }

  const events = Array.from(eventMap.values())
    .sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime));

  res.json({
    success: true,
    events
  });
});

// @desc    Bulk check-in/out for a registration
// @route   PATCH /api/events/:eventId/free/bulk-checkin/:ticketId
// @access  Private (organiser only)
export const bulkCheckInRegistration = asyncHandler(async (req, res) => {
  const { eventId, ticketId } = req.params;
  const { checkIn } = req.body; // boolean: true for check-in, false for check-out
  const userId = req.user._id;

  // 1. Find the ticket and verify authorization using eventSnapshot
  const ticket = await FreeTicket.findOne({ _id: ticketId, event: eventId });
  if (!ticket) {
    res.status(404);
    throw new Error('Registration not found');
  }

  // Check if user is the organizer using eventSnapshot
  if (ticket.eventSnapshot?.postedBy !== userId.toString()) {
    res.status(403);
    throw new Error('Not authorized to check in attendees for this event');
  }

  // 3. Update all attendees
  const checkInTime = checkIn ? new Date() : null;
  ticket.attendees.forEach(attendee => {
    attendee.checkedIn = checkIn;
    attendee.checkInTime = checkInTime;
  });

  // 4. Update ticket status
  ticket.status = checkIn ? 'checkedin' : 'registered';

  await ticket.save();

  res.json({ 
    success: true,
    message: checkIn ? 'All attendees checked in' : 'All attendees checked out',
    ticket 
  });
});
