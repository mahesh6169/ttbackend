import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import Event from '../../models/eventModel.js';
import User from '../../models/userModel.js';
import Message from '../../models/messageModel.js';
import FreeTicket from '../../models/freeTicket.js';
import WaitlistEntry from '../../models/waitlistEntry.js';
import bcrypt from 'bcryptjs';
import cloudinary from '../../utils/cloudinary.js';
import jwt from 'jsonwebtoken';
import {
  addEventNotification,
  updateEventNotification,
  deleteEventNotification,
} from '../../utils/notifications/events/sendEventNotifications.js';
import {
  sendEventUpdateNotification,
  sendEventDeletionNotification,
} from '../../utils/notifications/events/sendEventChangeNotifications.js';
import { COMMUNITY_VALUES } from '../../utils/constants/communities.js';
import { refreshFrontendCache } from '../../utils/refreshFrontendCache.js';
import { generateSlug, ensureUniqueSlug } from '../../utils/helpers/shared/generateSlug.js';
import {
  parseSharedFields,
  parseFreeEventFields,
  handleImageUploads,
  handleImageUpdates, // ✅ NEW: Import the unified update handler
  generateRecurringInstances,
  generateEventCode,
  calculateExpiryDate,
  determineEventStatus,
  calculateCurrentFreeRegistrations
} from '../../utils/events/helperFreeEvent.js';
import {
  parseSharedFields as parseSharedPaid,
  parsePaidEventFields,
  handleImageUploads as handlePaidImageUploads,
  handleImageUpdates as handlePaidImageUpdates,
  handleSeatingLayoutImageUpload,
  handleSeatingLayoutImageUpdate,
  generateEventCode as generatePaidEventCode,
  calculateExpiryDate as calculatePaidExpiryDate,
   determineEventStatus as determinePaidEventStatus,
   formatReservedSeatsForDisplay,
   reconcileDiscountCounters,
   assertBundlesFitPerRegistration,
} from '../../utils/events/helperPaidEvent.js';
// Add this with your other imports (around line 15-20)
import { cleanupExpiredReservations } from './reservationController.js';
import { calculateCurrentTicketsSold } from '../../utils/events/ticketHelpers.js';
import { cascadeDeleteEvent } from '../../utils/events/deleteEventHelpers.js';
import PaidTicket from '../../models/paidTicket.js';
import Reservation from '../../models/reservationModel.js';
import { hasBookedSeat, hasLiveHold, isStructuralLayoutChange, bookedSeats, assertBookedSeatsPreserved } from '../../utils/events/seatConfigLock.js';
import { reconcileTicketTypeLocks, assertDiscountLocks, assertQuestionLocks, assertEventTypeUnchanged, assertCapacityFloor } from '../../utils/events/editLocks.js';
import { finalizeRegistrationFields } from '../../utils/events/registrationFieldValidation.js';

const CURATOR_EMAILS = (process.env.CURATOR_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// @desc    Create a new event
// @route   POST /api/events/add-free
// @access  Private
export const addFreeEvent = asyncHandler(async (req, res) => {
  try {
    // ✅ Parse shared fields (validation happens inside)
    const sharedFields = parseSharedFields(req);
    
    // ✅ Use the dateTime as-is (frontend already converted to UTC)
    const dateTime = sharedFields.dateTime; // Already in UTC from frontend
    const userTimezone = sharedFields.timeZone; // Store for display purposes
    
    // ✅ Parse free event specific fields (recurrence)
    const freeFields = parseFreeEventFields(req);

    // ✅ Validate: Promotional events cannot be recurring
    if (sharedFields.eventIntent === 'promote' && freeFields.recurrence?.isRecurring) {
      return res.status(400).json({
        success: false,
        message: 'Promotional events cannot be recurring. Choose "Host" if you need a recurring event.'
      });
    }

    // ✅ Validate recurring events
    if (freeFields.recurrence?.isRecurring) {
      // End date is required for recurring events
      if (!freeFields.recurrence?.endDate) {
        return res.status(400).json({
          success: false,
          message: 'End date is required for recurring events'
        });
      }

      // Validate 6-month limit for free recurring events
      const startDate = new Date(dateTime);
      const endDate = new Date(freeFields.recurrence.endDate);
      const maxEndDate = new Date(startDate);
      maxEndDate.setMonth(maxEndDate.getMonth() + 6);

      if (endDate > maxEndDate) {
        return res.status(400).json({
          success: false,
          message: 'Free recurring events can have a maximum duration of 6 months'
        });
      }
    }

    // ✅ Handle image uploads using unified function
    const imagesDetails = await handleImageUploads(req, {
      maxImages: 10,
      requireImages: false
    });
    
    // ✅ Generate event code and calculate expiry
    const eventCode = await generateEventCode();
    const expiryDate = calculateExpiryDate(new Date(dateTime), freeFields.recurrence);

    const organiser = await User.findById(req.user._id);

    // ✅ Create parent event data
    // Parse and validate communities
    const { communities } = req.body;
    let parsedCommunities = [];
    try {
      parsedCommunities = communities ? 
        (typeof communities === 'string' ? JSON.parse(communities) : communities) : [];
    } catch (error) {
      return res.status(400).json({ success: false, message: 'Invalid JSON format for communities' });
    }
    
    // Validate communities
    if (parsedCommunities.length > 0) {
      const invalidCommunities = parsedCommunities.filter(c => !COMMUNITY_VALUES.includes(c));
      if (invalidCommunities.length > 0) {
        return res.status(400).json({ 
          success: false, 
          message: `Invalid communities: ${invalidCommunities.join(', ')}` 
        });
      }
    }

    const eventData = {
      // Basic info
      eventCode,
      title: sharedFields.title,
      category: sharedFields.category,
      communities: parsedCommunities,
      dateTime: new Date(dateTime), // Store as Date object (should be UTC from frontend)
      timeZone: userTimezone, // Store the timezone for display purposes
      venue: sharedFields.venue,
      description: sharedFields.description,
      address: sharedFields.parsedAddress,
      postedBy: req.user._id,
      stripeAccountId: organiser?.stripeAccountId || "",
      images: imagesDetails,
      organizer: sharedFields.organizer,
      coordinators: sharedFields.parsedCoordinators,

      // ✅ Recurrence (FREE EVENTS ONLY - disabled for promotional)
      recurrence: sharedFields.eventIntent === 'promote'
        ? { isRecurring: false, repeatSchedule: [], endDate: null, parentEventId: null }
        : freeFields.recurrence,

      // ✅ FREE EVENT DEFAULTS (isPaid can be true for promotional paid events)
      isPaid: req.body.isPaid === 'true' || req.body.isPaid === true,
      isAdvertiseOnly: sharedFields.isAdvertiseOnly || false,
      capacity: sharedFields.isAdvertiseOnly ? 0 : sharedFields.capacity,
      maxAttendeesPerRegistration: sharedFields.isAdvertiseOnly ? 0 : sharedFields.maxAttendeesPerRegistration,
      registrationFields: sharedFields.isAdvertiseOnly
        ? []
        : finalizeRegistrationFields(sharedFields.parsedRegistrationFields, false),
      ticketTypes: [], // No ticket types for free events
      seatingLayout: [],
      seatingLayoutImage: null,

      // ✅ Promotional event fields
      eventIntent: sharedFields.eventIntent,
      externalTicketUrl: sharedFields.externalTicketUrl,

      // ✅ Curated event flag (auto-set when creator's email is in CURATOR_EMAILS)
      isCuratedEvent: !!req.user?.email && CURATOR_EMAILS.includes(req.user.email.toLowerCase()),

      // ✅ System fields
      status: determineEventStatus(dateTime, freeFields.recurrence),
      expiryDate,
    };

    // Generate slug for SEO
    const baseSlug = generateSlug(eventData.title);
    eventData.slug = await ensureUniqueSlug(Event, baseSlug);

    // ✅ Create parent event
    const parentEvent = await Event.create(eventData);
    console.log(`✅ Parent event created: ${parentEvent._id}`);

    // 🏷️ Mark the poster's host-type flag (sticky; see HostTypeFlags.md)
    await User.updateOne(
      { _id: req.user._id },
      { $set: eventData.eventIntent === 'promote' ? { promoHost: true } : { freeHost: true } }
    );

    // ✅ Generate recurring instances if needed (backend does no timezone conversion)
    let instances = [];
    if (freeFields.recurrence.isRecurring) {
      instances = await generateRecurringInstances(parentEvent, freeFields.recurrence);
    }

    // ✅ Send notification email
    await parentEvent.populate('postedBy', 'email');
    try {
      await addEventNotification({ type: 'created', event: parentEvent });
    } catch (notifyErr) {
      console.warn("⚠️ Event creation email failed:", notifyErr.message);
    }

    // ✅ Prepare response
    const response = {
      success: true,
      message: freeFields.recurrence.isRecurring 
        ? `Free recurring event created successfully with ${instances.length} instances!`
        : 'Free event created successfully!',
      event: parentEvent,
      ...(freeFields.recurrence.isRecurring && {
        recurringInstances: instances.length,
        instances: instances.slice(0, 5) // Return first 5 instances for preview
      })
    };

    console.log(`✅ Free event creation complete. Parent: ${parentEvent._id}, Instances: ${instances.length}`);
    return res.status(201).json(response);

  } catch (err) {
    console.error("❌ Error creating free event:", err);
    return res.status(400).json({ 
      success: false, 
      message: err.message 
    });
  }
});

// @desc    Update a free event
// @route   PUT /api/events/update-free/:id
// @access  Private
export const updateFreeEvent = asyncHandler(async (req, res) => {
  try {
    const eventId = req.params.id;
    const existingEvent = await Event.findById(eventId);

    if (!existingEvent) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    // Check if user owns the event
    if (existingEvent.postedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    // ✅ Parse shared fields (validation happens inside)
    const sharedFields = parseSharedFields(req);
    
    // ✅ Use the dateTime as-is (frontend already converted to UTC)
    const dateTime = sharedFields.dateTime; // Already in UTC from frontend
    const userTimezone = sharedFields.timeZone; // Store for display purposes
    
    // ✅ Parse free event specific fields (recurrence)
    const freeFields = parseFreeEventFields(req);
    
    // ✅ Validate recurring events
    if (freeFields.recurrence?.isRecurring) {
      // End date is required for recurring events
      if (!freeFields.recurrence?.endDate) {
        return res.status(400).json({ 
          success: false, 
          message: 'End date is required for recurring events' 
        });
      }
      
      // Validate 6-month limit for free recurring events
      const startDate = new Date(dateTime);
      const endDate = new Date(freeFields.recurrence.endDate);
      const maxEndDate = new Date(startDate);
      maxEndDate.setMonth(maxEndDate.getMonth() + 6);
      
      if (endDate > maxEndDate) {
        return res.status(400).json({ 
          success: false, 
          message: 'Free recurring events can have a maximum duration of 6 months' 
        });
      }
    }

    // Parse and validate communities
    const { communities } = req.body;
    let parsedCommunities = [];
    try {
      parsedCommunities = communities ? 
        (typeof communities === 'string' ? JSON.parse(communities) : communities) : [];
    } catch (error) {
      return res.status(400).json({ success: false, message: 'Invalid JSON format for communities' });
    }
    
    // Validate communities
    if (parsedCommunities.length > 0) {
      const invalidCommunities = parsedCommunities.filter(c => !COMMUNITY_VALUES.includes(c));
      if (invalidCommunities.length > 0) {
        return res.status(400).json({ 
          success: false, 
          message: `Invalid communities: ${invalidCommunities.join(', ')}` 
        });
      }
    }

    // ✅ Handle image updates using unified function
    const finalImages = await handleImageUpdates(req, existingEvent.images, {
      maxImages: 10
    });
    
    // ✅ Calculate new expiry date
    const expiryDate = calculateExpiryDate(new Date(dateTime), freeFields.recurrence);

    // Snapshot the notify-worthy fields BEFORE they are overwritten (events-edit-locking.md D14): the
    // old check compared them after assignment and so never fired. Attendees are emailed when the
    // what/when/where actually changes.
    const prevNotify = {
      title: existingEvent.title,
      description: existingEvent.description,
      dateTime: existingEvent.dateTime ? new Date(existingEvent.dateTime).getTime() : null,
      timeZone: existingEvent.timeZone,
      venue: existingEvent.venue,
      address: JSON.stringify(existingEvent.address || {}),
    };

    // 🔒 Attendee-question lock (events-edit-locking.md D10): once a free event has RSVPs, an existing
    // question can't be edited or deleted (adding is fine). Checked before the fields are overwritten.
    const committedNowFree = await calculateCurrentFreeRegistrations(eventId);
    // Finalise the questions once (types/caps/unique/blocking) so the lock check and the save use
    // the same normalised list - a free-hosted event allows all eight types (events-rsvp-question-types.md).
    const finalizedFreeFields = sharedFields.isAdvertiseOnly
      ? []
      : finalizeRegistrationFields(sharedFields.parsedRegistrationFields, false);
    try {
      assertEventTypeUnchanged(existingEvent, {
        isPaid: req.body.isPaid === 'true' || req.body.isPaid === true,
        isAdvertiseOnly: sharedFields.isAdvertiseOnly,
      });
      if (!sharedFields.isAdvertiseOnly) {
        assertCapacityFloor(sharedFields.capacity, committedNowFree);
        assertQuestionLocks(existingEvent.hasActivity, existingEvent.registrationFields, finalizedFreeFields, false);
      }
    } catch (lockErr) {
      return res.status(lockErr.statusCode || 409).json({
        success: false,
        code: lockErr.code || 'EDIT_LOCKED',
        message: lockErr.message,
      });
    }

    // ✅ Update parent event data
    existingEvent.title = sharedFields.title;
    existingEvent.category = sharedFields.category;
    existingEvent.communities = parsedCommunities;
    existingEvent.dateTime = new Date(dateTime); // Store as Date object (should be UTC from frontend)
    existingEvent.timeZone = userTimezone; // Store the timezone for display purposes
    existingEvent.venue = sharedFields.venue;
    existingEvent.description = sharedFields.description;
    existingEvent.address = sharedFields.parsedAddress;
    existingEvent.images = finalImages; // ✅ Use properly processed images from unified handler
    existingEvent.organizer = sharedFields.organizer;
    existingEvent.coordinators = sharedFields.parsedCoordinators;
    existingEvent.isAdvertiseOnly = sharedFields.isAdvertiseOnly || false;
    existingEvent.capacity = sharedFields.isAdvertiseOnly ? 0 : sharedFields.capacity;
    existingEvent.maxAttendeesPerRegistration = sharedFields.isAdvertiseOnly ? 0 : sharedFields.maxAttendeesPerRegistration;
    existingEvent.registrationFields = finalizedFreeFields;
    existingEvent.expiryDate = expiryDate;
    existingEvent.status = determineEventStatus(dateTime, freeFields.recurrence);
    
    // ✅ Update recurrence (FREE EVENTS ONLY)
    existingEvent.recurrence = freeFields.recurrence;
    
    // ✅ Ensure FREE EVENT fields remain correct (isPaid can be true for promotional paid events)
    existingEvent.isPaid = req.body.isPaid === 'true' || req.body.isPaid === true;
    existingEvent.ticketTypes = []; // No ticket types for free events
    existingEvent.seatingLayout = [];
    existingEvent.seatingLayoutImage = null;

    // Critical (attendee-facing WHEN/WHERE) changes vs the pre-edit snapshot. Title + description are
    // deliberately excluded: a rename or copy tweak does not force an attendee to re-plan, so it does
    // not trigger the attendee broadcast (the organiser still gets the "updated" email). The per-field
    // flags drive the amber "(changed)" tags in the attendee email.
    const dateChanged = prevNotify.dateTime !== new Date(dateTime).getTime();
    const timeZoneChanged = prevNotify.timeZone !== userTimezone;
    const venueChanged = prevNotify.venue !== sharedFields.venue;
    const addressChanged = prevNotify.address !== JSON.stringify(sharedFields.parsedAddress);
    const changedFields = {
      date: dateChanged,
      time: dateChanged || timeZoneChanged, // the Time row shows both clock time and timezone
      venue: venueChanged,
      address: addressChanged,
    };
    const criticalFieldsChanged = dateChanged || timeZoneChanged || venueChanged || addressChanged;

    // ✅ Save updated parent event
    const updatedEvent = await existingEvent.save();
    console.log(`✅ Parent event updated: ${updatedEvent._id}`);

    // ✅ NEW: Update all child instances to match parent (Option B)
    let childInstanceIds = [];
    if (updatedEvent.recurrence?.isRecurring && !updatedEvent.recurrence?.parentEventId) {
      try {
        // Find all child instances
        const childInstances = await Event.find({ 
          'recurrence.parentEventId': updatedEvent._id 
        });
        
        // Update each child instance to match parent (except dateTime and eventCode)
        const updatePromises = childInstances.map(async (child) => {
          // Keep the child's specific dateTime and eventCode
          const childDateTime = child.dateTime;
          const childEventCode = child.eventCode;
          const childExpiryDate = calculateExpiryDate(childDateTime, freeFields.recurrence);
          
          // Update all other fields to match parent
          child.title = updatedEvent.title;
          child.category = updatedEvent.category;
          child.timeZone = updatedEvent.timeZone;
          child.venue = updatedEvent.venue;
          child.description = updatedEvent.description;
          child.address = updatedEvent.address;
          child.images = updatedEvent.images; // ✅ SYNC IMAGES
          child.organizer = updatedEvent.organizer;
          child.coordinators = updatedEvent.coordinators;
          child.capacity = updatedEvent.capacity;
          child.maxAttendeesPerRegistration = updatedEvent.maxAttendeesPerRegistration;
          child.registrationFields = updatedEvent.registrationFields;
          child.communities = updatedEvent.communities; // ✅ SYNC COMMUNITIES
          child.expiryDate = childExpiryDate;
          child.status = determineEventStatus(childDateTime, { ...freeFields.recurrence, parentEventId: updatedEvent._id });
          child.recurrence = { ...freeFields.recurrence, parentEventId: updatedEvent._id };
          
          // Keep child-specific fields
          child.dateTime = childDateTime; // Keep original child dateTime
          child.eventCode = childEventCode; // Keep original child eventCode
          
          return child.save();
        });
        
        await Promise.all(updatePromises);
        childInstanceIds = childInstances.map((child) => child._id);
        console.log(`✅ Successfully updated ${childInstances.length} child instances`);
        
      } catch (err) {
        console.error("❌ Error updating child instances:", err.message);
        // Don't fail the entire update if child sync fails
        console.warn("⚠️ Parent updated successfully, but child instance sync failed");
      }
    }

    // ✅ Send notification email to organizer
    await updatedEvent.populate('postedBy', 'email');
    try {
      await updateEventNotification({ type: 'updated', event: updatedEvent });
    } catch (notifyErr) {
      console.warn("⚠️ Event update email failed:", notifyErr.message);
    }

    // Send change notification to attendees if critical fields changed
    if (criticalFieldsChanged) {
      console.log("📧 Sending event change notifications to attendees...");
      const eventSnapshot = {
        _id: updatedEvent._id,
        eventCode: updatedEvent.eventCode,
        title: updatedEvent.title,
        dateTime: updatedEvent.dateTime,
        timeZone: updatedEvent.timeZone,
        venue: updatedEvent.venue,
        address: updatedEvent.address,
        organizer: updatedEvent.organizer,
        recurrence: updatedEvent.recurrence,
        changed: changedFields, // per-field flags -> amber "(changed)" tags in the attendee email
      };
      // Fire and forget - don't wait for notifications to complete
      sendEventUpdateNotification(updatedEvent._id, eventSnapshot).catch(notifyErr => {
        console.error("❌ Failed to send attendee notifications:", notifyErr.message);
      });
    }

    // Fresh share previews straight after the edit (instances share the parent's details)
    await refreshFrontendCache([updatedEvent._id, ...childInstanceIds].map((id) => `event-${id}`));

    // ✅ Prepare response
    const response = {
      success: true,
      message: updatedEvent.recurrence?.isRecurring && !updatedEvent.recurrence?.parentEventId
        ? 'Recurring event and all instances updated successfully!'
        : 'Free event updated successfully!',
      event: updatedEvent,
    };

    console.log(`✅ Free event update complete: ${updatedEvent._id}`);
    return res.status(200).json(response);

  } catch (err) {
    console.error("❌ Error updating free event:", err);
    return res.status(400).json({ 
      success: false, 
      message: err.message 
    });
  }
});

// @desc    Create a new paid event
// @route   POST /api/events/add-paid
// @access  Private
export const addPaidEvent = asyncHandler(async (req, res) => {
  try {
    // 🔒 Stripe gate: only fully-onboarded organisers can create paid events.
    // 'fully_active' already implies charges + payouts enabled and no outstanding
    // requirements (see utils/events/stripeAccountHelpers.js). Fail fast, before any uploads.
    const organiser = await User.findById(req.user._id).select('stripeAccountStatus stripeAccountId');
    if (!organiser || organiser.stripeAccountStatus !== 'fully_active') {
      return res.status(403).json({
        success: false,
        code: 'STRIPE_NOT_READY',
        message: 'Complete your Stripe payout setup before creating a paid event.',
      });
    }

    // Shared fields
    const sharedFields = parseSharedPaid(req);
    const dateTime = sharedFields.dateTime;
    const userTimezone = sharedFields.timeZone;

    // Paid event-specific fields
    const paidFields = parsePaidEventFields(req);

    // Bundle guard: no bundle may be larger than the event's max-tickets-per-order.
    assertBundlesFitPerRegistration(paidFields.ticketTypes, sharedFields.maxAttendeesPerRegistration);

    // Parse and validate communities
    const { communities } = req.body;
    let parsedCommunities = [];
    try {
      parsedCommunities = communities ?
        (typeof communities === 'string' ? JSON.parse(communities) : communities) : [];
    } catch (error) {
      return res.status(400).json({ success: false, message: 'Invalid JSON format for communities' });
    }

    // Validate communities
    if (parsedCommunities.length > 0) {
      const invalidCommunities = parsedCommunities.filter(c => !COMMUNITY_VALUES.includes(c));
      if (invalidCommunities.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Invalid communities: ${invalidCommunities.join(', ')}`
        });
      }
    }

    // Images (main event images)
    const imagesDetails = await handlePaidImageUploads(req, {
      maxImages: 10,
      requireImages: false
    });

    // Handle seating layout image upload
    const seatingLayoutImage = await handleSeatingLayoutImageUpload(req);
    
    // Update paidFields with the uploaded image if any
    if (seatingLayoutImage) {
      paidFields.seatingLayoutImage = seatingLayoutImage;
    }

    // Generate event code and expiry date
    const eventCode = await generatePaidEventCode();
    const expiryDate = calculatePaidExpiryDate(new Date(dateTime));

    // Build event data
    const eventData = {
      eventCode,
      title: sharedFields.title,
      category: sharedFields.category,
      communities: parsedCommunities,
      dateTime: new Date(dateTime),
      timeZone: userTimezone,
      venue: sharedFields.venue,
      description: sharedFields.description,
      address: sharedFields.parsedAddress,
      postedBy: req.user._id,
      images: imagesDetails,
      organizer: sharedFields.organizer,
      coordinators: sharedFields.parsedCoordinators,

      // Paid event fields
      isPaid: true,
      ticketTypes: paidFields.ticketTypes,
      discountCodes: paidFields.discountCodes, // 🏷️ create-time defaults (usedCount 0, remaining = maxUses)
      seatingLayout: paidFields.seatingLayout,
      seatingLayoutImage: paidFields.seatingLayoutImage,
      capacity: sharedFields.capacity,
      maxAttendeesPerRegistration: sharedFields.maxAttendeesPerRegistration,
      // Paid events accept only text + dropdown; the finalizer rejects a new type and strips blocking.
      registrationFields: finalizeRegistrationFields(sharedFields.parsedRegistrationFields, true),

      // Financial fields — server-derived from the authenticated organiser, never the client body
      stripeAccountId: organiser.stripeAccountId,

      // Refund policy (paid events only)
      refundPolicy: paidFields.refundPolicy,

      // GST configuration (paid events only)
      gstIncluded: paidFields.gstIncluded,

      // ✅ Paid events are always hosted (never promotional)
      eventIntent: 'host',
      externalTicketUrl: '',

      // ✅ Curated event flag (auto-set when creator's email is in CURATOR_EMAILS)
      isCuratedEvent: !!req.user?.email && CURATOR_EMAILS.includes(req.user.email.toLowerCase()),

      // System fields
      status: determinePaidEventStatus(dateTime, null),
      expiryDate,
      organizerReservedSeats: paidFields.organizerReservedSeatsUserFormat || '',
      organizerBlockedSeats: paidFields.organizerBlockedSeatsUserFormat || '',
      seatingLayoutFlipH: !!paidFields.seatingLayoutFlipH,
    };

    // Generate slug for SEO
    const baseSlug = generateSlug(eventData.title);
    eventData.slug = await ensureUniqueSlug(Event, baseSlug);

    // Create event
    const newEvent = await Event.create(eventData);
    console.log(`✅ Paid event created: ${newEvent._id}`);

    // 🏷️ Mark the poster as a paid-event host (sticky; see HostTypeFlags.md)
    await User.updateOne({ _id: req.user._id }, { $set: { paidHost: true } });

    // Populate postedBy for email notification
    await newEvent.populate('postedBy', 'email name');

    // Send email notification for paid event creation
    try {
      await addEventNotification({ type: 'created', event: newEvent });
    } catch (emailError) {
      console.error("❌ Failed to send paid event creation email:", emailError.message);
      // Don't fail the request if email fails
    }

    res.status(201).json({
      success: true,
      message: 'Paid event created successfully!',
      event: newEvent,
    });
  } catch (err) {
    console.error("❌ Error creating paid event:", err);
    res.status(400).json({
      success: false,
      message: err.message,
    });
  }
});

// @desc    Update a paid event
// @route   PUT /api/events/update-paid/:id
// @access  Private
export const updatePaidEvent = asyncHandler(async (req, res) => {
  try {
    const eventId = req.params.id;
    const existingEvent = await Event.findById(eventId);

    if (!existingEvent) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    if (existingEvent.postedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    // 🔒 Stripe gate: a paid event can only be written by a fully-onboarded organiser
    // (same rule as create). Payout account is server-derived, never from the client body.
    const organiser = await User.findById(req.user._id).select('stripeAccountStatus stripeAccountId');
    if (!organiser || organiser.stripeAccountStatus !== 'fully_active') {
      return res.status(403).json({
        success: false,
        code: 'STRIPE_NOT_READY',
        message: 'Complete your Stripe payout setup before editing a paid event.',
      });
    }

    // Shared fields
    const sharedFields = parseSharedPaid(req);
    const dateTime = sharedFields.dateTime;
    const userTimezone = sharedFields.timeZone;

    // Paid event-specific fields
    const paidFields = parsePaidEventFields(req);

    // 🔒 Seat-configuration wall (featureplans/fix-events-seatmap-salelock.md): the seating layout is
    // freely editable until the event's first sale; after a sale it is locked. A structural rebuild is
    // ALSO refused while a live attendee hold exists (it would corrupt a checkout in progress). A
    // non-structural update (title/description, or the same layout re-submitted) always passes through.
    const storedLayout = existingEvent.seatingLayout || [];
    const submittedLayout = paidFields.seatingLayout || [];
    const bookedStored = bookedSeats(storedLayout);
    if (bookedStored.length > 0) {
      // Orientation lock (events-layout-tools.md D6): a horizontal flip moves a booked seat's rendered
      // position, so the flip is frozen once any seat sells (skip-driven label changes are caught by the
      // structural check below). The row-generation controls are already frozen in the UI.
      if (!!paidFields.seatingLayoutFlipH !== !!existingEvent.seatingLayoutFlipH) {
        return res.status(409).json({
          success: false,
          code: 'SEATS_SOLD_LOCKED',
          message: 'This event has sold seats, so the seating orientation is locked.',
        });
      }
      // Seated lock (events-edit-locking.md, revised): the hall is a fixed room, so once a seat sells
      // the whole layout STRUCTURE freezes - no adding, removing, resizing, renaming rows or aisles.
      // Only reserving/releasing the still-free seats stays live (a seat-status change, not a structure
      // change - the fingerprint ignores status). Booked seats can't be released or re-reserved.
      if (isStructuralLayoutChange(storedLayout, submittedLayout)) {
        return res.status(409).json({
          success: false,
          code: 'SEATS_SOLD_LOCKED',
          message: 'This event has sold seats, so the seating layout is locked. You can still reserve or release the seats that are still free.',
        });
      }
      try {
        assertBookedSeatsPreserved(storedLayout, submittedLayout);
      } catch (seatErr) {
        return res.status(seatErr.statusCode || 409).json({
          success: false,
          code: seatErr.code || 'SEATS_SOLD_LOCKED',
          message: seatErr.message,
        });
      }
    } else if (isStructuralLayoutChange(storedLayout, submittedLayout)) {
      // No booked seats yet, but a recorded sale or a live hold still blocks a restructure (the
      // pre-existing sale-lock rule, unchanged).
      const sold = !!(await PaidTicket.exists({ event: String(existingEvent._id) }));
      if (sold) {
        return res.status(409).json({
          success: false,
          code: 'SEATS_SOLD_LOCKED',
          message:
            'This event has sold seats, so its seating layout is locked. To change the layout, recreate the event and reserve the already-sold seats.',
        });
      }
      const heldNow =
        hasLiveHold(storedLayout) ||
        !!(await Reservation.exists({
          eventId: existingEvent._id,
          status: 'active',
          expiresAt: { $gt: new Date() },
        }));
      if (heldNow) {
        return res.status(409).json({
          success: false,
          code: 'SEATS_HELD_TRY_AGAIN',
          message:
            'Someone is choosing seats right now. Please try again in a few minutes and your changes will save.',
        });
      }
    }

    // Bundle guard: no bundle may be larger than the event's max-tickets-per-order. Because this
    // runs against the newly-submitted limit, lowering the limit below a live bundle's size is rejected.
    assertBundlesFitPerRegistration(paidFields.ticketTypes, sharedFields.maxAttendeesPerRegistration);

    // Parse and validate communities
    const { communities } = req.body;
    let parsedCommunities = [];
    try {
      parsedCommunities = communities ?
        (typeof communities === 'string' ? JSON.parse(communities) : communities) : [];
    } catch (error) {
      return res.status(400).json({ success: false, message: 'Invalid JSON format for communities' });
    }

    // Validate communities
    if (parsedCommunities.length > 0) {
      const invalidCommunities = parsedCommunities.filter(c => !COMMUNITY_VALUES.includes(c));
      if (invalidCommunities.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Invalid communities: ${invalidCommunities.join(', ')}`
        });
      }
    }

    // Images update
    const finalImages = await handlePaidImageUpdates(req, existingEvent.images, {
      maxImages: 10
    });
    
    // Handle seating layout image update
    const seatingLayoutImage = await handleSeatingLayoutImageUpdate(req, existingEvent.seatingLayoutImage);
    
    // Update paidFields with the uploaded/updated image if any
    if (seatingLayoutImage) {
      paidFields.seatingLayoutImage = seatingLayoutImage;
    }

    // Expiry
    const expiryDate = calculatePaidExpiryDate(new Date(dateTime));

    // 🔒 Activity-based edit locks (events-edit-locking.md D8/D9/D10). Re-checked fresh at save against
    // the still-loaded stored event; a locked change is refused with 409 (the disabled UI is a courtesy).
    // reconcileTicketTypeLocks also carries each sold type's hasSold flag forward (the client can't set it).
    // Capacity floor (D11): computed fresh here, re-checked below - never trust a client count.
    const committedNowPaid = await calculateCurrentTicketsSold(eventId);
    // Finalise once (paid = text + dropdown only, blocking stripped) for both the lock check and save.
    const finalizedPaidFields = sharedFields.isAdvertiseOnly
      ? []
      : finalizeRegistrationFields(sharedFields.parsedRegistrationFields, true);
    let reconciledTicketTypes;
    try {
      assertEventTypeUnchanged(existingEvent, { isPaid: true, isAdvertiseOnly: sharedFields.isAdvertiseOnly });
      // For a seated event the floor is the booked-seat count even if no PaidTicket rows exist (D11/AC14).
      if (!sharedFields.isAdvertiseOnly) assertCapacityFloor(sharedFields.capacity, Math.max(committedNowPaid, bookedStored.length));
      reconciledTicketTypes = reconcileTicketTypeLocks(paidFields.ticketTypes, existingEvent.ticketTypes);
      assertDiscountLocks(existingEvent.discountCodes, paidFields.discountCodes);
      if (!sharedFields.isAdvertiseOnly) {
        assertQuestionLocks(existingEvent.hasActivity, existingEvent.registrationFields, finalizedPaidFields, true);
      }
    } catch (lockErr) {
      return res.status(lockErr.statusCode || 409).json({
        success: false,
        code: lockErr.code || 'EDIT_LOCKED',
        message: lockErr.message,
      });
    }

    // Snapshot the notify-worthy fields BEFORE they are overwritten (events-edit-locking.md D14): the
    // old check compared them after assignment and so never fired. Buyers are emailed when the
    // what/when/where actually changes.
    const prevNotify = {
      title: existingEvent.title,
      description: existingEvent.description,
      dateTime: existingEvent.dateTime ? new Date(existingEvent.dateTime).getTime() : null,
      timeZone: existingEvent.timeZone,
      venue: existingEvent.venue,
      address: JSON.stringify(existingEvent.address || {}),
    };

    // Update event fields
    existingEvent.title = sharedFields.title;
    existingEvent.category = sharedFields.category;
    existingEvent.communities = parsedCommunities;
    existingEvent.dateTime = new Date(dateTime);
    existingEvent.timeZone = userTimezone;
    existingEvent.venue = sharedFields.venue;
    existingEvent.description = sharedFields.description;
    existingEvent.address = sharedFields.parsedAddress;
    existingEvent.images = finalImages;
    existingEvent.organizer = sharedFields.organizer;
    existingEvent.coordinators = sharedFields.parsedCoordinators;
    existingEvent.isAdvertiseOnly = sharedFields.isAdvertiseOnly || false;
    existingEvent.capacity = sharedFields.isAdvertiseOnly ? 0 : sharedFields.capacity;
    existingEvent.maxAttendeesPerRegistration = sharedFields.isAdvertiseOnly ? 0 : sharedFields.maxAttendeesPerRegistration;
    existingEvent.registrationFields = finalizedPaidFields;
    existingEvent.expiryDate = expiryDate;

    // Paid event fields
    existingEvent.isPaid = true;
    existingEvent.ticketTypes = reconciledTicketTypes; // hasSold preserved; locked changes already refused above
    // 🏷️ Discount codes: counters are server-owned — preserve usedCount from the existing
    // codes, enforce V4 (max uses can't drop below used), recompute remainingUses.
    existingEvent.discountCodes = reconcileDiscountCounters(paidFields.discountCodes, existingEvent.discountCodes);
    existingEvent.seatingLayout = paidFields.seatingLayout;
    // Edit-locking signal (events-edit-locking.md D4): a saved non-empty layout marks the event as
    // seated so the edit wizard runs the seated rules. Only ever flips on.
    if (Array.isArray(paidFields.seatingLayout) && paidFields.seatingLayout.some((r) => (r?.seats || []).length > 0)) {
      existingEvent.hasSeating = true;
    }
    existingEvent.seatingLayoutImage = paidFields.seatingLayoutImage;
    existingEvent.stripeAccountId = organiser?.stripeAccountId || existingEvent.stripeAccountId; // 🔒 server-derived
    existingEvent.refundPolicy = paidFields.refundPolicy;
    existingEvent.gstIncluded = paidFields.gstIncluded;
    existingEvent.organizerReservedSeats = paidFields.organizerReservedSeatsUserFormat || '';
    existingEvent.organizerBlockedSeats = paidFields.organizerBlockedSeatsUserFormat || '';
    existingEvent.seatingLayoutFlipH = !!paidFields.seatingLayoutFlipH;
    existingEvent.status = determinePaidEventStatus(dateTime, null);

    // Critical (attendee-facing WHEN/WHERE) changes vs the pre-edit snapshot. Title + description are
    // deliberately excluded: a rename or copy tweak does not force an attendee to re-plan, so it does
    // not trigger the attendee broadcast (the organiser still gets the "updated" email). The per-field
    // flags drive the amber "(changed)" tags in the attendee email.
    const dateChanged = prevNotify.dateTime !== new Date(dateTime).getTime();
    const timeZoneChanged = prevNotify.timeZone !== userTimezone;
    const venueChanged = prevNotify.venue !== sharedFields.venue;
    const addressChanged = prevNotify.address !== JSON.stringify(sharedFields.parsedAddress);
    const changedFields = {
      date: dateChanged,
      time: dateChanged || timeZoneChanged, // the Time row shows both clock time and timezone
      venue: venueChanged,
      address: addressChanged,
    };
    const criticalFieldsChanged = dateChanged || timeZoneChanged || venueChanged || addressChanged;


    const updatedEvent = await existingEvent.save();
    console.log(`✅ Paid event updated: ${updatedEvent._id}`);
    
    // Populate postedBy for email notification
    await updatedEvent.populate('postedBy', 'email name');
    
    // Send email notification to organizer for paid event update
    try {
      await updateEventNotification({ type: 'updated', event: updatedEvent });
    } catch (emailError) {
      console.error("❌ Failed to send paid event update email:", emailError.message);
      // Don't fail the request if email fails
    }

    // Send change notification to ticket holders if critical fields changed
    if (criticalFieldsChanged) {
      console.log("📧 Sending event change notifications to ticket holders...");
      const eventSnapshot = {
        _id: updatedEvent._id,
        eventCode: updatedEvent.eventCode,
        title: updatedEvent.title,
        dateTime: updatedEvent.dateTime,
        timeZone: updatedEvent.timeZone,
        venue: updatedEvent.venue,
        address: updatedEvent.address,
        organizer: updatedEvent.organizer,
        recurrence: updatedEvent.recurrence,
        changed: changedFields, // per-field flags -> amber "(changed)" tags in the attendee email
      };
      // Fire and forget - don't wait for notifications to complete
      sendEventUpdateNotification(updatedEvent._id, eventSnapshot).catch(notifyErr => {
        console.error("❌ Failed to send ticket holder notifications:", notifyErr.message);
      });
    }

    // Fresh share previews straight after the edit
    await refreshFrontendCache(`event-${updatedEvent._id}`);

    res.status(200).json({
      success: true,
      message: 'Paid event updated successfully!',
      event: updatedEvent,
    });
  } catch (err) {
    console.error("❌ Error updating paid event:", err);
    res.status(400).json({
      success: false,
      message: err.message,
    });
  }
});

// @desc    Fetch an event
export const fetchAllEvents = asyncHandler(async (req, res) => {
  const events = await Event.find().populate('postedBy', 'name email');
  res.status(200).json(events);
});

// @desc    Public organiser page: all of one organiser's published, upcoming/currently-running events
// @route   GET /api/events/by/:slug
// @access  Public - see featureplans/events-by-organiser.md
export const getEventsByOrganiserSlug = asyncHandler(async (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase();
  const organiser = await User.findOne({ slug }).select(
    '_id name organiserShareTitle organiserShareDescription organiserShareImage'
  );
  if (!organiser) {
    return res.status(404).json({ success: false, message: 'Organiser not found' });
  }

  // Published (goLive) events of any type, upcoming OR currently running (not yet expired), never past
  // or offline; scoped to this organiser only. Soonest first.
  const now = new Date();
  const events = await Event.find({
    postedBy: organiser._id,
    goLive: true,
    demo: { $ne: true },
    deletedByOrganiser: { $ne: true }, // organiser-cancelled events never show as upcoming (events-past-events.md)
    isBlocked: { $ne: true }, // moderation-blocked events are public nowhere (events-delete-retention.md D5)
    expiryDate: { $gte: now },
  }).sort({ dateTime: 1 });

  // Heading / share-card display name. organiserShareTitle, when the owner has set it, is the
  // authoritative name and wins over everything else (events-organiser-share-meta.md) - so an
  // organiser with only offline events (or none) still reads properly. Otherwise fall back to the
  // organiser.name on their most recent event (per-event free text; use the latest if it varies),
  // then the account name. Never the slug (D6).
  const latest = await Event.findOne({ postedBy: organiser._id }).sort({ dateTime: -1 }).select('organizer');
  const organiserName =
    organiser.organiserShareTitle?.trim() ||
    latest?.organizer?.name?.trim() ||
    organiser.name ||
    'Organiser';

  // Optional organiser-level share card fields (events-organiser-share-meta.md). Returned as-is so
  // the organiser page's generateMetadata can use them when set and fall back to defaults when empty.
  const organiserShareTitle = organiser.organiserShareTitle || '';
  const organiserShareDescription = organiser.organiserShareDescription || '';
  const organiserShareImage = organiser.organiserShareImage || '';

  res.status(200).json({
    success: true,
    organiserName,
    organiserShareTitle,
    organiserShareDescription,
    organiserShareImage,
    events,
  });
});

// Discount codes must never leak to the public (feature-add-discountcode.md S2). The event
// OWNER (matched via optional auth) keeps the full discountCodes array for the edit wizard;
// every other viewer gets ONLY redeemable, show-hint codes reduced to display-safe fields
// (no secret codes, no maxUses / usedCount / remainingUses counters). Mutates eventObj in place.
const publicizeDiscountCodes = (eventObj, reqUser) => {
  const codes = Array.isArray(eventObj.discountCodes) ? eventObj.discountCodes : [];
  const ownerId = eventObj.postedBy?._id?.toString?.() || eventObj.postedBy?.toString?.();
  const isOwner = !!reqUser && !!ownerId && reqUser._id.toString() === ownerId;
  if (isOwner) return; // owner edits — keep everything

  const now = new Date();
  eventObj.discountCodes = codes
    .filter((d) =>
      d.showHint === true &&
      d.active !== false &&
      (!d.validFrom || new Date(d.validFrom) <= now) &&
      (!d.validUntil || new Date(d.validUntil) >= now) &&
      (d.remainingUses == null || d.remainingUses > 0)
    )
    .map((d) => ({
      code: d.code,
      kind: d.kind,
      value: d.value,
      appliesToTicketTypes: d.appliesToTicketTypes || [],
      showHint: true,
    }));
};

// @desc    Fetch a single event by ID
// @route   GET /api/events/views/:id
// @access  Public (optional auth — owner sees full discount codes)
export const fetchEventById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Check if this is a synthetic ID for a recurring instance (contains underscore)
  if (id.includes('_')) {
    const [parentId, dateTimeStr] = id.split('_');
    const instanceDate = new Date(dateTimeStr);

    // ✅ Clean up expired reservations for recurring instance
    await cleanupExpiredReservations(parentId);

    const parentEvent = await Event.findById(parentId).populate('postedBy', 'name email');
    
    if (!parentEvent) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }
    
    if (!parentEvent.recurrence?.isRecurring) {
      return res.status(404).json({ success: false, message: 'Not a recurring event' });
    }

    // events-delete-retention.md D5: a blocked event's page reads as not-found - reuses the
    // existing not-found UI on both the slug and legacy detail pages, no new frontend state.
    if (parentEvent.isBlocked) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    const recurringInstance = {
      ...parentEvent.toObject(),
      _id: id,
      dateTime: instanceDate,
      isRecurringInstance: true,
      parentEventId: parentId
    };

    // Optimize images before sending
    if (recurringInstance.images && recurringInstance.images.length > 0) {
      recurringInstance.images = recurringInstance.images.map(image => ({
        ...(image.toObject ? image.toObject() : image),
        optimizedUrls: image.publicId ? {
          mobile: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_320,h_160,c_fill/${image.publicId}`,
          desktop: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_448,h_224,c_fill/${image.publicId}`,
          mobileDetail: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_400,h_200,c_fit/${image.publicId}`,
          desktopDetail: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_800,h_400,c_fit/${image.publicId}`,
          fullscreen: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_1920,c_limit/${image.publicId}`
        } : null,
        ogImageUrl: image.publicId ? `https://res.cloudinary.com/dtvrbdvkx/image/upload/w_1200,h_630,c_fill,f_auto,q_auto:good,fl_lossy/${image.publicId}` : null
      }));
      
      // Only use optimized URL, skip raw images (frontend handles fallback)
      recurringInstance.ogImageUrl = recurringInstance.images[0].ogImageUrl || null;
    }

    // Optimize seating layout images for recurring instance (now supports array)
    if (recurringInstance.seatingLayoutImage && recurringInstance.seatingLayoutImage.length > 0) {
      recurringInstance.seatingLayoutImage = recurringInstance.seatingLayoutImage.map(image => ({
        ...(image.toObject ? image.toObject() : image),
        optimizedUrls: image.publicId ? {
          mobile: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_400,c_limit/${image.publicId}`,
          desktop: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_800,c_limit/${image.publicId}`,
          fullscreen: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_1920,c_limit/${image.publicId}`
        } : null
      }));
    }

    publicizeDiscountCodes(recurringInstance, req.user);
    return res.status(200).json(recurringInstance);
  }

  // ✅ Clean up expired reservations BEFORE fetching the event
  await cleanupExpiredReservations(id);
  
  const event = await Event.findById(id).populate('postedBy', 'name email');

  if (!event) {
    return res.status(404).json({ success: false, message: 'Event not found' });
  }

  // events-delete-retention.md D5: a blocked event's page reads as not-found - reuses the
  // existing not-found UI on both the slug and legacy detail pages, no new frontend state.
  if (event.isBlocked) {
    return res.status(404).json({ success: false, message: 'Event not found' });
  }

  // Convert to plain object so we can add properties
  const eventObj = event.toObject();
 
  // Optimize images before sending
  if (eventObj.images && eventObj.images.length > 0) {
    eventObj.images = eventObj.images.map(image => ({
      ...image,
      optimizedUrls: image.publicId ? {
        mobile: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_320,h_160,c_fill/${image.publicId}`,
        desktop: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_448,h_224,c_fill/${image.publicId}`,
        mobileDetail: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_400,h_200,c_fit/${image.publicId}`,
        desktopDetail: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_800,h_400,c_fit/${image.publicId}`,
        fullscreen: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_1920,c_limit/${image.publicId}`
      } : null,
      ogImageUrl: image.publicId ? `https://res.cloudinary.com/dtvrbdvkx/image/upload/w_1200,h_630,c_fill,f_auto,q_auto:good,fl_lossy/${image.publicId}` : null
    }));
    
    // Only use optimized URL, skip raw images (frontend handles fallback)
    eventObj.ogImageUrl = eventObj.images[0].ogImageUrl || null;
  }

  // Optimize seating layout images before sending (now supports array)
  if (eventObj.seatingLayoutImage && eventObj.seatingLayoutImage.length > 0) {
    eventObj.seatingLayoutImage = eventObj.seatingLayoutImage.map(image => ({
      ...image,
      optimizedUrls: image.publicId ? {
        mobile: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_400,c_limit/${image.publicId}`,
        desktop: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_800,c_limit/${image.publicId}`,
        fullscreen: `https://res.cloudinary.com/dtvrbdvkx/image/upload/f_auto,q_auto,w_1920,c_limit/${image.publicId}`
      } : null
    }));
  }

  // Edit-locking (events-edit-locking.md D5): the committed attendee count powers the capacity floor
  // in the edit wizard. Computed fresh here (the atomic oversell counter is not yet shipped) and
  // re-checked again at save. Owner-only, alongside the full discount codes.
  const isOwner = req.user && event.postedBy && String(event.postedBy._id) === String(req.user._id);
  if (isOwner) {
    eventObj.committedCount = event.isPaid
      ? await calculateCurrentTicketsSold(id)
      : await calculateCurrentFreeRegistrations(id);
  }

  publicizeDiscountCodes(eventObj, req.user);

  // Canonical grouping (events-seo-canonical.md): if this event points at a hero via
  // seoCanonicalEventId, resolve the hero's CURRENT public URL and attach it so the
  // detail page can canonical to it. The URL is built title-first with generateSlug -
  // exactly like createSlugUrl / the sitemap / the hero's own self-canonical - NOT from
  // the stored slug field, which can drift from the title (so a stored slug would emit a
  // canonical that does not match the hero's real indexed URL). Missing or soft-deleted
  // hero => attach nothing => the page falls back to its self-canonical.
  if (eventObj.seoCanonicalEventId) {
    const hero = await Event.findById(eventObj.seoCanonicalEventId)
      .select('title deletedByOrganiser')
      .lean();
    if (hero && !hero.deletedByOrganiser) {
      const siteUrl = process.env.WEBSITE_URL || 'https://desify.com.au';
      eventObj.seoCanonicalUrl = `${siteUrl}/events/${generateSlug(hero.title)}-${hero._id}`;
    }
  }

  res.status(200).json(eventObj);
});

// @desc    Fetch all events posted by the current user
// @route   GET /api/events/mine
// @access  Private
export const fetchMyEvents = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  // Only fetch parent (series) events
  const myEvents = await Event.find({
    postedBy: userId,
    'recurrence.parentEventId': null, // Only parent events
    deletedByOrganiser: { $ne: true }, // soft-deleted events drop out of the manage list (events-past-events.md)
    isBlocked: { $ne: true }, // moderation-blocked events drop out of the manage list too (events-delete-retention.md D5)
  }).lean();

  // Attach each event's waitlist count (the organiser's demand meter) in one grouped query
  // rather than a query per event. See featureplans/events-waitlist.md.
  const eventIds = myEvents.map((e) => e._id);
  const counts = await WaitlistEntry.aggregate([
    { $match: { event: { $in: eventIds } } },
    { $group: { _id: '$event', count: { $sum: 1 } } },
  ]);
  const countByEvent = new Map(counts.map((c) => [String(c._id), c.count]));
  const withCounts = myEvents.map((e) => ({
    ...e,
    waitlistCount: countByEvent.get(String(e._id)) || 0,
  }));

  res.status(200).json(withCounts);
});

// @desc    Public "Past events" list for /events (events-past-events.md)
// @route   GET /api/events/past
// @access  Public
// Past is DATE-based: the event's end (expiryDate) is before now - NOT the stored `status` (which goes
// stale because it is only recomputed on save), so a past event nobody edited still appears. Published
// parent events only; soft-deleted past events still show (they stay public); admin-purged ones are gone.
export const getPastEvents = asyncHandler(async (req, res) => {
  const now = new Date();
  const page = Number(req.query.page) || 1;
  const limit = Math.min(Number(req.query.limit) || 12, 48);
  const skip = (page - 1) * limit;

  // events-past-offline-curation.md D1/D2: eligibility is ENDED-by-date only (live, offline, or
  // organiser-deleted all qualify); the admin featuredInPast flag is the only public gate. A
  // moderation-blocked event is the one exception - it is public nowhere (events-delete-retention.md D5).
  const filter = {
    'recurrence.parentEventId': null,
    demo: { $ne: true },
    expiryDate: { $lt: now },
    featuredInPast: true, // admin-curated: only featured past events show publicly (events-past-events.md)
    isBlocked: { $ne: true },
  };

  const total = await Event.countDocuments(filter);
  const events = await Event.find(filter)
    .sort({ dateTime: -1 }) // most recent past events first
    .skip(skip)
    .limit(limit)
    .lean();

  res.status(200).json({
    success: true,
    events,
    meta: {
      totalItems: total,
      currentPage: page,
      totalPages: Math.ceil(total / limit),
      itemsPerPage: limit,
    },
  });
});

// @desc    Delete an event by ID
// @route   DELETE /api/events/:id
// @access  Private
export const deleteEvent = asyncHandler(async (req, res) => {
  const event = await Event.findById(req.params.id);
  if (!event) {
    return res.status(404).json({ success: false, message: 'Event not found' });
  }

  if (event.postedBy.toString() !== req.user._id.toString()) {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }

  // SOFT delete (events-past-events.md): the organiser "delete" marks the event (and any recurring
  // children) and hides it from the manage list + the upcoming/discover lists, but keeps the doc and its
  // image so a PAST event still renders publicly in the Past events section. No cascade, no image delete -
  // the admin purge queue is the only hard delete (which frees storage).
  const now = new Date();
  const isPast = event.expiryDate && new Date(event.expiryDate) < now;

  await Event.updateMany(
    { $or: [{ _id: event._id }, { 'recurrence.parentEventId': event._id }] },
    {
      $set: {
        deletedByOrganiser: true,
        deletedByOrganiserAt: now,
        deletedByOrganiserBy: req.user._id,
      },
    }
  );

  // A FUTURE (not-yet-past) delete is a cancellation - tell the attendees/ticket holders. A past event
  // just leaves the record behind, so there is nobody to notify.
  if (!isPast) {
    sendEventDeletionNotification(event, 'organizer').catch((notifyErr) => {
      console.error('Failed to send cancellation notifications:', notifyErr.message);
    });
  }

  res.status(200).json({
    success: true,
    softDeleted: true,
    cancelled: !isPast,
    deletedEventId: event._id,
  });
});

// @desc    Get current event capacity and availability
// @route   GET /api/events/:eventId/capacity
// @access  Public
export const getEventCapacity = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  
  try {
    // First, trigger cleanup of expired reservations
    await cleanupExpiredReservations(eventId);
    
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ 
        success: false, 
        message: 'Event not found' 
      });
    }
    
    let soldTickets;
    let activeReservations = 0;
    let occupiedSeats = 0;
    
    if (event.isPaid) {
      // Count confirmed tickets
      soldTickets = await calculateCurrentTicketsSold(eventId);
      
      // Count seats that are not available (selected, reserved, booked, or not-for-sale/blocked)
      if (event.seatingLayout && event.seatingLayout.length > 0) {
        event.seatingLayout.forEach(section => {
          section.seats.forEach(seat => {
            if (seat.status === 'selected' || seat.status === 'reserved' || seat.status === 'booked' || seat.status === 'blocked') {
              occupiedSeats++;
            }
          });
        });
      }
      
      // Count active reservations with safety checks
      const Reservation = (await import('../../models/reservationModel.js')).default;
      
      // Only count reservations that:
      // - Are active
      // - Haven't expired (with 30 second buffer)
      // - Have valid ticket data
      // - Are NOT from the current user (if logged in)
      const bufferTime = new Date(Date.now() + 30000); // 30 sec buffer
      
      // Build match criteria
      const matchCriteria = {
        eventId: new mongoose.Types.ObjectId(eventId),
        status: 'active',
        expiresAt: { $gt: bufferTime },
        tickets: { $exists: true, $ne: [] }
      };
      
      // Exclude current user's reservation if user is logged in
      if (req.user && req.user._id) {
        matchCriteria.userId = { $ne: new mongoose.Types.ObjectId(req.user._id) };
      }
      
      const pipeline = [
        {
          $match: matchCriteria
        },
        {
          $unwind: {
            path: '$tickets',
            preserveNullAndEmptyArrays: false
          }
        },
        {
          $match: {
            'tickets.quantity': { $gt: 0 }
          }
        },
        {
          $group: {
            _id: null,
            totalReserved: { $sum: '$tickets.quantity' },
            reservationCount: { $addToSet: '$_id' } // Track unique reservations
          }
        },
        {
          $project: {
            totalReserved: 1,
            reservationCount: { $size: '$reservationCount' }
          }
        }
      ];
      
      const result = await Reservation.aggregate(pipeline);
      activeReservations = result[0]?.totalReserved || 0;
      const activeReservationCount = result[0]?.reservationCount || 0;
      
    } else {
      // Free events
      soldTickets = await calculateCurrentFreeRegistrations(eventId);
      // TODO: Also count reservations for free events if needed
    }
    
    // Calculate effective capacity
    const totalCapacity = event.capacity || 0;
    
    // For events with seating layout, use seat status count
    // For events without seating, use ticket sales + reservations
    let effectiveSold;
    if (event.seatingLayout && event.seatingLayout.length > 0) {
      // For seated events: count occupied seats + active reservations
      // Active reservations represent tickets that will require seat selection
      // This ensures accurate capacity even before seats are selected
      effectiveSold = occupiedSeats + activeReservations;
    } else {
      // For non-seated events: count tickets + reservations
      effectiveSold = soldTickets + activeReservations;
    }
    
    const remainingCapacity = totalCapacity > 0 ? 
      Math.max(0, totalCapacity - effectiveSold) : 
      'unlimited';
    
    // Detect over-capacity situations
    if (totalCapacity > 0 && effectiveSold > totalCapacity) {
      console.error(`⚠️ OVER-CAPACITY: Event ${eventId} has ${effectiveSold} tickets (${soldTickets} sold + ${activeReservations} reserved) but capacity is ${totalCapacity}`);
      // Could trigger another cleanup or alert admin
    }
    
    // Calculate confirmed allocations for "sold out" display (NOT for remaining calculation)
    let confirmedAllocations;
    if (event.seatingLayout && event.seatingLayout.length > 0) {
      // For seated events: only count reserved + booked seats
      const reservedSeats = event.seatingLayout.reduce((sum, section) => 
        sum + section.seats.filter(s => s.status === 'reserved').length, 0);
      const bookedSeats = event.seatingLayout.reduce((sum, section) => 
        sum + section.seats.filter(s => s.status === 'booked').length, 0);
      confirmedAllocations = reservedSeats + bookedSeats;
    } else {
      // For non-seated events: only count sold tickets (not reservations)
      confirmedAllocations = soldTickets;
    }

    res.json({
      success: true,
      capacity: {
        total: totalCapacity,
        sold: soldTickets,
        reserved: activeReservations,
        occupiedSeats: occupiedSeats, // NEW: count of non-available seats
        remaining: remainingCapacity,
        isUnlimited: totalCapacity === 0,
        confirmedAllocations: confirmedAllocations, // NEW: for "sold out" display only
        status: totalCapacity > 0 && effectiveSold >= totalCapacity ? 'sold-out' : 'available',
        hasSeatingLayout: event.seatingLayout && event.seatingLayout.length > 0,
        // Additional debug info (remove in production)
        debug: {
          effectiveTotal: effectiveSold,
          seatBreakdown: event.seatingLayout && event.seatingLayout.length > 0 ? {
            selected: event.seatingLayout.reduce((sum, section) => 
              sum + section.seats.filter(s => s.status === 'selected').length, 0),
            reserved: event.seatingLayout.reduce((sum, section) => 
              sum + section.seats.filter(s => s.status === 'reserved').length, 0),
            booked: event.seatingLayout.reduce((sum, section) => 
              sum + section.seats.filter(s => s.status === 'booked').length, 0),
            available: event.seatingLayout.reduce((sum, section) => 
              sum + section.seats.filter(s => s.status === 'available').length, 0)
          } : null,
          lastCleanup: new Date().toISOString()
        }
      }
    });
  } catch (error) {
    console.error('❌ Error fetching event capacity:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch event capacity'
    });
  }
});

export const getSitemapEvents = asyncHandler(async (req, res) => {
  try {
    // Return only future events
    // Slug is generated dynamically by frontend using title + _id
    const events = await Event.find({
      dateTime: { $gte: new Date() },
      isBlocked: { $ne: true }, // a blocked event is not listed anywhere (events-delete-retention.md D5)
    })
      .select('title _id updatedAt')
      .sort({ updatedAt: -1 })
      .limit(50000)
      .lean();

    return res.status(200).json(events);
  } catch (error) {
    console.error('Error fetching events for sitemap:', error.message);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// @desc    Toggle event goLive status
// @route   PATCH /api/events/:id/toggle-golive
// @access  Private (Event owner only)
export const toggleEventGoLive = asyncHandler(async (req, res) => {
  try {
    const eventId = req.params.id;
    const { goLive } = req.body;

    const event = await Event.findById(eventId);

    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    // Check if user owns the event
    if (event.postedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    // Listing a PAID event live requires a fully active Stripe account (able to accept payments
    // and receive payouts) — the same bar used to CREATE a paid event. On Stripe disconnect this
    // status is reset to 'no_account', so this stops a hidden paid event from being re-listed with
    // no account to receive payment. Free/RSVP/promo events are unaffected.
    if (goLive && event.isPaid && req.user.stripeAccountStatus !== 'fully_active') {
      return res.status(400).json({
        success: false,
        message: 'Set up your Stripe payouts before making a paid event live so you can receive payments.'
      });
    }

    // Toggle goLive status
    event.goLive = goLive;
    await event.save();

    return res.status(200).json({
      success: true,
      message: `Event is now ${goLive ? 'Live' : 'Offline'}`,
      event
    });
  } catch (error) {
    console.error('Error toggling goLive:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to toggle goLive status'
    });
  }
});

// @desc    Toggle event waitlist on/off
// @route   PATCH /api/events/:id/toggle-waitlist
// @access  Private (Event owner only)
// Mirror of toggleEventGoLive; no Stripe gate - the waitlist never touches money.
export const toggleEventWaitlist = asyncHandler(async (req, res) => {
  try {
    const eventId = req.params.id;
    const { enabled } = req.body;

    const event = await Event.findById(eventId);

    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    // Check if user owns the event
    if (event.postedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    event.waitlistEnabled = !!enabled;
    await event.save();

    return res.status(200).json({
      success: true,
      message: `Waitlist is now ${event.waitlistEnabled ? 'On' : 'Off'}`,
      event
    });
  } catch (error) {
    console.error('Error toggling waitlist:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to toggle waitlist'
    });
  }
});