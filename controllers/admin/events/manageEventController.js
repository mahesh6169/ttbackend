import asyncHandler from 'express-async-handler';
import Event from '../../../models/eventModel.js';
import Message from '../../../models/messageModel.js';
import { sendEventReminder } from '../../../utils/notifications/events/sendEventReminder.js';
import { deleteEventNotification } from '../../../utils/notifications/events/sendEventNotifications.js';
import { sendEventDeletionNotification } from '../../../utils/notifications/events/sendEventChangeNotifications.js';
import cloudinary from '../../../utils/cloudinary.js';
import { cascadeDeleteEvent } from '../../../utils/events/deleteEventHelpers.js';
import { PLATFORM_PRICE_CONFIG, getEffectivePlatformFee, validatePlatformFee, validatePlatformFeePercentage, formatPlatformFeeBreakdown } from '../../../utils/constants/platformPriceConfig.js';
import PaidTicket from '../../../models/paidTicket.js';

export const getManageEvents = asyncHandler(async (req, res) => {
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 10;
  const skip = (page - 1) * limit;
  const now = new Date();

  try {
    // Only count parent events
    const total = await Event.countDocuments({
      'recurrence.parentEventId': null
    });

    // Only fetch parent events (exclude child recurring instances)
    const events = await Event.find({
      'recurrence.parentEventId': null
    })
      .populate('postedBy', 'email name')
      .sort({ expiryDate: 1 })
      .skip(skip)
      .limit(limit);

    const enrichedEvents = await Promise.all(
      events.map(async (event) => {
        const isRecurring = event.recurrence?.isRecurring;
        // Use the stored expiryDate field (already includes +5 days buffer)
        const expiryTime = new Date(event.expiryDate).getTime();
        const nowTime = now.getTime();
        const daysLeft = Math.floor((expiryTime - nowTime) / (1000 * 60 * 60 * 24));

        const sentNotify1 = !!event.notify1SentAt;
        const sentNotify2 = !!event.notify2SentAt;

        let status = daysLeft >= 0 ? 'active' : 'expired';
        let toBeDeleted = false;

        // 🧹 Mark for deletion if 2+ days past notify2
        if (
          event.notify2SentAt &&
          nowTime > new Date(event.notify2SentAt).getTime() + 2 * 24 * 60 * 60 * 1000 &&
          !event.toBeDeleted
        ) {
          event.toBeDeleted = true;
          await event.save();
        }

        // 🎯 Action Flags
        const actions = {
          notify1: {
            enabled: !sentNotify1 && nowTime >= expiryTime,
          },
          notify2: {
            enabled: sentNotify1 && !sentNotify2 && nowTime >= new Date(event.notify1SentAt).getTime() + 7 * 24 * 60 * 60 * 1000,
          },
          delete: {
            enabled: event.toBeDeleted === true,
          },
          moderationDelete: {
            enabled: true,
          },
        };

        return {
          _id: event._id,
          title: event.title,
          email: event.postedBy?.email || 'N/A',
          dateTime: event.dateTime,
          timeZone: event.timeZone || 'Australia/Sydney',
          status,
          actions,
          isRecurring,
          isBlocked: !!event.isBlocked,
        };
      })
    );

    return res.status(200).json({
      success: true,
      events: enrichedEvents,
      meta: {
        totalItems: total,
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        itemsPerPage: limit,
      },
    });
  } catch (error) {
    console.error('❌ Error fetching manage events:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch events',
      error: error.message,
    });
  }
});


// @desc    Admin purge queue: events the organiser soft-deleted or an admin has blocked, awaiting a
//          hard delete to free storage
// @route   GET /api/admin/events/purge-queue
// @access  Admin only
// events-past-events.md D5, events-delete-retention.md D5/AC8: the admin sees what organisers have let
// go of AND what moderation has hidden, and hard-deletes when they choose (subject to the sold-ticket
// guard in deleteEventById for a future event).
export const getPurgeQueue = asyncHandler(async (req, res) => {
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 20;
  const skip = (page - 1) * limit;

  const filter = {
    'recurrence.parentEventId': null,
    $or: [{ deletedByOrganiser: true }, { isBlocked: true }],
  };

  const total = await Event.countDocuments(filter);
  const events = await Event.find(filter)
    .populate('postedBy', 'email name')
    .sort({ updatedAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  const rows = events.map((e) => ({
    _id: e._id,
    title: e.title,
    email: e.postedBy?.email || 'N/A',
    organiser: e.postedBy?.name || e.organizer?.name || 'N/A',
    dateTime: e.dateTime,
    isPaid: !!e.isPaid,
    image: e.images?.[0]?.url || null,
    deletedByOrganiser: !!e.deletedByOrganiser,
    deletedAt: e.deletedByOrganiserAt,
    isBlocked: !!e.isBlocked,
    blockedAt: e.blockedAt,
  }));

  return res.status(200).json({
    success: true,
    events: rows,
    meta: {
      totalItems: total,
      currentPage: page,
      totalPages: Math.ceil(total / limit),
      itemsPerPage: limit,
    },
  });
});

// @desc    Admin "Past events" curation list: past-dated events the admin can feature on /events
// @route   GET /api/admin/events/past-curation
// @access  Admin only
// events-past-events.md: the public Past strip is admin-picked - this lists past events with their
// featured state so the admin toggles which ones show.
export const getPastCurationList = asyncHandler(async (req, res) => {
  const now = new Date();
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 20;
  const skip = (page - 1) * limit;

  // events-past-offline-curation.md D1: past eligibility is ENDED-by-date only - live, offline,
  // and organiser-deleted events are all eligible. The go-live flag plays no part here. A
  // moderation-blocked event is the one exception: it is public nowhere, so it never reaches
  // curation - it only ever surfaces in the purge queue (events-delete-retention.md D5).
  const filter = {
    'recurrence.parentEventId': null,
    demo: { $ne: true },
    expiryDate: { $lt: now },
    isBlocked: { $ne: true },
  };

  const total = await Event.countDocuments(filter);
  const events = await Event.find(filter)
    .populate('postedBy', 'email name')
    .sort({ dateTime: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  const rows = events.map((e) => ({
    _id: e._id,
    title: e.title,
    email: e.postedBy?.email || 'N/A',
    dateTime: e.dateTime,
    isPaid: !!e.isPaid,
    image: e.images?.[0]?.url || null,
    featuredInPast: !!e.featuredInPast,
    deletedByOrganiser: !!e.deletedByOrganiser,
    offline: !e.goLive,
  }));

  return res.status(200).json({
    success: true,
    events: rows,
    meta: {
      totalItems: total,
      currentPage: page,
      totalPages: Math.ceil(total / limit),
      itemsPerPage: limit,
    },
  });
});

// @desc    Admin toggle: feature/unfeature a past event in the public Past events strip
// @route   PATCH /api/admin/events/:id/past-featured
// @access  Admin only
export const setPastFeatured = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const featured = req.body.featured === true || req.body.featured === 'true';

  const event = await Event.findById(id);
  if (!event) {
    return res.status(404).json({ success: false, message: 'Event not found' });
  }

  event.featuredInPast = featured;
  await event.save();

  return res.status(200).json({ success: true, _id: event._id, featuredInPast: event.featuredInPast });
});

export const sendEventReminderEmail = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { type } = req.body; // expects '1' or '2'

  if (!['1', '2'].includes(type)) {
    return res.status(400).json({ success: false, message: 'Invalid reminder type' });
  }

  const event = await Event.findById(id).populate('postedBy', 'email');
  if (!event || !event.postedBy?.email) {
    return res.status(404).json({ success: false, message: 'Event or user not found' });
  }

  // Send email (you should adapt sendEventReminder to handle type)
  await sendEventReminder(event, type);

  // Update the correct reminder timestamp
  if (type === '1') {
    event.notify1SentAt = new Date();
  } else if (type === '2') {
    event.notify2SentAt = new Date();
  }

  await event.save();

  return res.status(200).json({ success: true, message: `Notify${type} email sent successfully.` });
});



  export const deleteEventById = asyncHandler(async (req, res) => {
    const eventId = req.params.id;
  
    console.log(`🗑️ Admin Delete Event: ${eventId}`);
  
    const event = await Event.findById(eventId).populate('postedBy', 'email');
  
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    // events-delete-retention.md D4: refuse a permanent delete of a FUTURE paid event that still
    // has an unrefunded sold ticket - the admin refunds or cancels first. "Future" uses the same
    // past/future line the rest of the admin surfaces already use (expiryDate vs now). A PAST
    // event is always deletable regardless of sold tickets (AC5), and this guard never applies to
    // a moderation block (D6 - blockEventById does not call this endpoint at all).
    const isPastEvent = new Date(event.expiryDate) < new Date();
    if (event.isPaid && !isPastEvent) {
      const soldCount = await PaidTicket.countDocuments({
        event: String(event._id),
        checkInStatus: { $ne: 'cancelled' },
        refundStatus: { $ne: 'full' },
      });
      if (soldCount > 0) {
        return res.status(409).json({
          success: false,
          message: `This event has ${soldCount} sold ticket${soldCount === 1 ? '' : 's'} that ${soldCount === 1 ? 'is' : 'are'} not fully refunded. Refund or cancel them before deleting.`,
        });
      }
    }

    // Collect child event IDs if this is a recurring parent
    let childEventIds = [];
    if (event.recurrence?.isRecurring && !event.recurrence?.parentEventId) {
      const childEvents = await Event.find({ 'recurrence.parentEventId': event._id }).select('_id');
      childEventIds = childEvents.map(child => child._id);
      console.log(`📋 Found ${childEventIds.length} child instances for recurring event`);
    }
  
    // 🌐 Optional fallback image ID to skip deleting
    const FALLBACK_PUBLIC_ID =
      process.env.FALLBACK_EVENT_IMAGE_PUBLIC_ID || "tagtelugudev/assets/No_Image_Available_mq5h6q";
  
    // 📧 Send deletion notifications BEFORE cascade delete (fire and forget)
    // 1. Notify organizer about admin deletion
    try {
      await deleteEventNotification({ type: 'deletedByAdmin', event });
    } catch (notifyErr) {
      console.warn("⚠️ Organizer notification failed:", notifyErr.message);
      // Continue with deletion even if notification fails
    }
    
    // 2. Notify attendees about event cancellation (only for future events)
    if (event.isPaid || !event.isPaid) { // Send for both free and paid events
      console.log("📧 Sending event cancellation notifications to attendees...");
      sendEventDeletionNotification(event, 'admin').catch(notifyErr => {
        console.error("❌ Failed to send attendee notifications:", notifyErr.message);
      });
    }
  
    // 🗑️ Perform cascade delete (waitlist entries, seat holds, wishlists; retains Free/Paid tickets)
    let cascadeDeleteSummary = {};
    try {
      cascadeDeleteSummary = await cascadeDeleteEvent(event, childEventIds);
      console.log('📊 Cascade delete summary:', cascadeDeleteSummary);
    } catch (cascadeErr) {
      console.error('❌ Cascade delete error:', cascadeErr);
      // Continue with event deletion even if cascade fails
    }
  
    // 🗑️ Delete child events from database
    if (childEventIds.length > 0) {
      await Event.deleteMany({ '_id': { $in: childEventIds } });
      console.log(`✅ Deleted ${childEventIds.length} child instances from database`);
    }
    
    // 🗑️ Delete all related messages (including messages for child events)
    const allEventIds = [event._id, ...childEventIds];
    try {
      const messageDeleteResult = await Message.deleteMany({ 
        relatedTo: 'event', 
        event: { $in: allEventIds } 
      });
      console.log(`🗑️ Deleted ${messageDeleteResult.deletedCount} messages for ${allEventIds.length} events`);
    } catch (messageErr) {
      console.error('❌ Error deleting messages:', messageErr);
      // Continue with deletion even if message deletion fails
    }
  
    // 🖼️ Delete Cloudinary images (after event deletion)
    if (event.images && event.images.length > 0) {
      for (const image of event.images) {
        if (image.publicId === FALLBACK_PUBLIC_ID) {
          console.log(`ℹ️ Skipping fallback image: ${image.publicId}`);
          continue;
        }
        try {
          await cloudinary.uploader.destroy(image.publicId);
        } catch (error) {
          console.error(`❌ Cloudinary Deletion Error (${image.publicId}):`, error.message);
        }
      }
    }
  
    // 🗑️ Delete the parent event
    try {
      const deleted = await Event.deleteOne({ _id: eventId });
  
      if (deleted.deletedCount === 0) {
        return res.status(500).json({
          success: false,
          message: 'Failed to delete event from database',
        });
      }
  
      return res.status(200).json({
        success: true,
        message: childEventIds.length > 0 
          ? `Event series deleted successfully (${childEventIds.length + 1} events total)`
          : 'Event deleted successfully',
        deletedEventId: eventId,
        deletedChildCount: childEventIds.length,
        cascadeSummary: cascadeDeleteSummary
      });
    } catch (error) {
      console.error('❌ Error deleting event from DB:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while deleting event',
        error: error.message,
      });
    }
  });

// @desc    Admin moderation: instantly hide an event without destroying it (events-delete-retention.md
//          D5-D7). The event and its images are kept, and it appears in the purge queue for a later
//          permanent delete. No sold-ticket guard - a scam event must be removable instantly (D6). No
//          reason field - who and when is enough (D7).
// @route   PATCH /api/admin/events/:id/block
// @access  Admin only
export const blockEventById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const event = await Event.findById(id);
  if (!event) {
    return res.status(404).json({ success: false, message: 'Event not found' });
  }

  event.isBlocked = true;
  event.blockedAt = new Date();
  event.blockedBy = req.user.id;
  await event.save();

  return res.status(200).json({ success: true, isBlocked: true, blockedAt: event.blockedAt });
});

// @desc    Get all paid events with platform fees (for dropdown)
// @route   GET /api/admin/events/paid-events-list
// @access  Admin only
export const getPaidEventsList = asyncHandler(async (req, res) => {
  try {
    // Fetch only paid events with minimal data for dropdown
    const events = await Event.find({ 
      isPaid: true,
      'recurrence.parentEventId': null // Exclude child recurring events
    })
    .select('title eventCode dateTime platformFee platformFeePercentage organizer.name')
    .sort({ dateTime: -1 }) // Most recent first
    .lean();

    console.log(`📋 Found ${events.length} paid events for platform fee management`);

    res.status(200).json({
      success: true,
      count: events.length,
      events: events.map(event => ({
        _id: event._id,
        title: event.title,
        eventCode: event.eventCode,
        dateTime: event.dateTime,
        platformFee: event.platformFee,
        platformFeePercentage: event.platformFeePercentage,
        organizerName: event.organizer?.name || 'N/A'
      }))
    });

  } catch (error) {
    console.error('❌ Error fetching paid events list:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch events list',
      error: error.message
    });
  }
});

// @desc    Get platform fee for a specific event
// @route   GET /api/admin/events/:eventId/platform-fee
// @access  Admin only
export const getEventPlatformFee = asyncHandler(async (req, res) => {
  try {
    const { eventId } = req.params;

    const event = await Event.findById(eventId)
      .select('title eventCode platformFee platformFeePercentage isPaid organizer.name');

    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    if (!event.isPaid) {
      return res.status(400).json({
        success: false,
        message: 'Platform fees only apply to paid events'
      });
    }

    const effectiveFees = getEffectivePlatformFee(event);

    res.status(200).json({
      success: true,
      eventId: event._id,
      title: event.title,
      eventCode: event.eventCode,
      organizerName: event.organizer?.name || 'N/A',
      platformFee: event.platformFee, // null or custom value
      platformFeePercentage: event.platformFeePercentage, // null or custom value
      effectiveFlatFee: effectiveFees.flatFee,     // what will actually be charged
      effectivePercentage: effectiveFees.percentage, // what will actually be charged
      effectiveFeeBreakdown: formatPlatformFeeBreakdown(effectiveFees.flatFee, effectiveFees.percentage),
      defaultFee: PLATFORM_PRICE_CONFIG.DEFAULT_PLATFORM_FEE,
      defaultPercentage: PLATFORM_PRICE_CONFIG.DEFAULT_PLATFORM_FEE_PERCENTAGE
    });

  } catch (error) {
    console.error('❌ Error fetching event platform fee:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch platform fee',
      error: error.message
    });
  }
});

// @desc    Update platform fee for an event
// @route   PUT /api/admin/events/:eventId/platform-fee
// @access  Admin only
export const updateEventPlatformFee = asyncHandler(async (req, res) => {
  try {
    const { eventId } = req.params;
    const { platformFee, platformFeePercentage } = req.body;

    // Find the event
    const event = await Event.findById(eventId);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    if (!event.isPaid) {
      return res.status(400).json({
        success: false,
        message: 'Platform fees only apply to paid events'
      });
    }

    // Handle fee updates
    let updatedFields = [];
    
    // Update flat fee if provided
    if (platformFee !== undefined) {
      if (platformFee === null || platformFee === '') {
        event.platformFee = null;
        updatedFields.push('flat fee reset to default');
      } else {
        const feeValue = Number(platformFee);
        const validation = validatePlatformFee(feeValue);
        
        if (!validation.isValid) {
          return res.status(400).json({
            success: false,
            message: validation.error
          });
        }
        
        event.platformFee = feeValue;
        updatedFields.push(`flat fee set to $${feeValue.toFixed(2)}`);
      }
    }
    
    // Update percentage if provided
    if (platformFeePercentage !== undefined) {
      if (platformFeePercentage === null || platformFeePercentage === '') {
        event.platformFeePercentage = null;
        updatedFields.push('percentage reset to default');
      } else {
        const percentageValue = Number(platformFeePercentage);
        const validation = validatePlatformFeePercentage(percentageValue);
        
        if (!validation.isValid) {
          return res.status(400).json({
            success: false,
            message: validation.error
          });
        }
        
        event.platformFeePercentage = percentageValue;
        updatedFields.push(`percentage set to ${percentageValue}%`);
      }
    }
    
    // Save if any changes were made
    if (updatedFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fee values provided to update'
      });
    }
    
    await event.save();
    
    const effectiveFees = getEffectivePlatformFee(event);
    const updateMessage = `Platform fee updated: ${updatedFields.join(', ')}`;
    
    console.log(`✅ ${updateMessage} for event ${eventId} (${event.title})`);

    res.status(200).json({
      success: true,
      message: updateMessage,
      platformFee: event.platformFee,
      platformFeePercentage: event.platformFeePercentage,
      effectiveFlatFee: effectiveFees.flatFee,
      effectivePercentage: effectiveFees.percentage,
      effectiveFeeBreakdown: formatPlatformFeeBreakdown(effectiveFees.flatFee, effectiveFees.percentage)
    });

  } catch (error) {
    console.error('❌ Error updating platform fee:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update platform fee',
      error: error.message
    });
  }
});