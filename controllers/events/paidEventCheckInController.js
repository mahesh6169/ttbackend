// controllers/events/paidEventCheckInController.js

import asyncHandler from 'express-async-handler';
import PaidTicket from '../../models/paidTicket.js';

// @desc    Get user's managed paid events
// @route   GET /api/events/user/managed/paid
// @access  Private
export const getManagedPaidEvents = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  console.log('🔍 Fetching managed paid events for user:', userId);

  try {
    // Get all unique events from PaidTickets where user is the organizer
    // This approach is resilient to event deletion
    const eventGroups = await PaidTicket.aggregate([
      {
        $match: {
          'eventSnapshot.postedBy': userId.toString(),
          'eventSnapshot.isPaid': true,
          // Only include active events (not cancelled/deleted in snapshot)
          'eventSnapshot.status': 'active'
        }
      },
      {
        $group: {
          _id: '$eventSnapshot.eventCode', // Group by eventCode for uniqueness
          event: { $first: '$event' }, // Original event ID
          eventSnapshot: { $last: '$eventSnapshot' }, // Use latest ticket's snapshot
          firstTicketCreatedAt: { $min: '$createdAt' },
          ticketCount: { $sum: 1 }
        }
      },
      {
        $project: {
          _id: '$event', // Use original event ID as _id
          eventCode: '$_id', // The grouped eventCode
          title: '$eventSnapshot.title',
          dateTime: '$eventSnapshot.dateTime',
          timeZone: '$eventSnapshot.timeZone',
          venue: '$eventSnapshot.venue',
          address: '$eventSnapshot.address',
          capacity: '$eventSnapshot.capacity',
          ticketCount: '$ticketCount'
        }
      },
      {
        $sort: { dateTime: 1 } // Sort by event date ascending
      }
    ]);

    console.log(`✅ Found ${eventGroups.length} unique paid events for organizer`);

    res.json({
      success: true,
      events: eventGroups
    });

  } catch (error) {
    console.error('❌ Error fetching managed paid events:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch managed events',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @desc    Get all attendees for a paid event
// @route   GET /api/events/:eventId/paid/attendees
// @access  Private (organizer only)
export const getPaidEventAttendees = asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const userId = req.user._id;
  
  // Extract pagination and search parameters
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const search = req.query.search || '';
  const skip = (page - 1) * limit;

  console.log('🔍 Fetching attendees for event:', eventId);

  try {
    // First, get a sample ticket to verify organizer access
    // This approach works even if the Event document is deleted
    const sampleTicket = await PaidTicket.findOne({ event: eventId })
      .select('eventSnapshot');
    
    if (!sampleTicket) {
      console.log('❌ No tickets found for event:', eventId);
      // Return empty result set instead of error
      return res.json({
        success: true,
        registrations: [],
        pagination: {
          currentPage: page,
          totalPages: 0,
          totalCount: 0,
          limit,
          hasNextPage: false,
          hasPrevPage: false
        }
      });
    }

    // 🔒 SECURITY: Check if user is the organizer using eventSnapshot
    if (sampleTicket.eventSnapshot.postedBy !== userId.toString()) {
      console.log('❌ Access denied - not the organizer');
      console.log('EventSnapshot postedBy:', sampleTicket.eventSnapshot.postedBy);
      console.log('Requesting user:', userId.toString());
      
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view attendees for this event'
      });
    }

    console.log('✅ Organizer access verified via eventSnapshot');

    // Build search query
    const query = { 
      event: eventId,
      checkInStatus: { $in: ['confirmed', 'checked-in'] }  // Excludes 'cancelled' tickets 
    };
    
    if (search) {
      const searchRegex = new RegExp(search, 'i');
      query.$or = [
        { ticketNumber: searchRegex },
        { invoiceNumber: searchRegex },
        { 'buyer.firstName': searchRegex },
        { 'buyer.lastName': searchRegex },
        { 'buyer.email': searchRegex },
        { 'attendees.name': searchRegex },
        { 'formResponses.response': searchRegex }
      ];
    }

    // Get total count for pagination
    const totalCount = await PaidTicket.countDocuments(query);

    // Find tickets with pagination and search
    const tickets = await PaidTicket.find(query)
      .populate('user', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    // Format the response similar to free events
    const registrations = tickets.map(ticket => ({
      _id: ticket._id,
      ticketNumber: ticket.ticketNumber,
      invoiceNumber: ticket.invoiceNumber,
      buyer: ticket.buyer,
      user: ticket.user,
      attendees: ticket.attendees,
      ticketType: ticket.ticketType,
      seats: ticket.seats,
      checkInStatus: ticket.checkInStatus,
      priceDetails: ticket.priceDetails,
      createdAt: ticket.createdAt,
      formResponses: ticket.formResponses || []
    }));

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalCount / limit);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;

    console.log(`✅ Found ${registrations.length} tickets for event ${eventId}`);

    res.json({
      success: true,
      registrations,
      pagination: {
        currentPage: page,
        totalPages,
        totalCount,
        limit,
        hasNextPage,
        hasPrevPage
      }
    });

  } catch (error) {
    console.error('❌ Error fetching attendees:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch attendees',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @desc    Check in an attendee for paid event
// @route   PATCH /api/events/:eventId/paid/checkin/:ticketId
// @access  Private (organizer only)
export const checkinPaidEvent = asyncHandler(async (req, res) => {
  const { eventId, ticketId } = req.params;
  const { attendeeId } = req.body;
  const userId = req.user._id;

  // Find the ticket and verify authorization
  const ticket = await PaidTicket.findOne({ _id: ticketId, event: eventId });
  if (!ticket) {
    res.status(404);
    throw new Error('Ticket not found');
  }

  // Check if user is the organizer using eventSnapshot
  if (ticket.eventSnapshot?.postedBy !== userId.toString()) {
    res.status(403);
    throw new Error('Not authorized to check in attendees for this event');
  }

  // Find the specific attendee
  const attendee = ticket.attendees.id(attendeeId);
  if (!attendee) {
    res.status(404);
    throw new Error('Attendee not found');
  }

  // Check if already checked in
  if (attendee.checkedIn) {
    res.status(400);
    throw new Error('Attendee already checked in');
  }

  // Update check-in status
  attendee.checkedIn = true;
  attendee.checkInTime = new Date();
  attendee.checkedInBy = userId;

  // Update ticket status if all attendees are checked in
  const allCheckedIn = ticket.attendees.every(att => att.checkedIn);
  if (allCheckedIn) {
    ticket.checkInStatus = 'checked-in';
  }

  await ticket.save();

  res.json({ 
    success: true, 
    message: 'Attendee checked in', 
    ticket 
  });
});

// @desc    Undo check-in for an attendee
// @route   PATCH /api/events/:eventId/paid/undo-checkin/:ticketId
// @access  Private (organizer only)
export const undoCheckinPaidEvent = asyncHandler(async (req, res) => {
  const { eventId, ticketId } = req.params;
  const { attendeeId } = req.body;
  const userId = req.user._id;

  // Find the ticket and verify authorization
  const ticket = await PaidTicket.findOne({ _id: ticketId, event: eventId });
  if (!ticket) {
    res.status(404);
    throw new Error('Ticket not found');
  }

  // Check if user is the organizer using eventSnapshot
  if (ticket.eventSnapshot?.postedBy !== userId.toString()) {
    res.status(403);
    throw new Error('Not authorized to undo check-in');
  }

  // Find the specific attendee
  const attendee = ticket.attendees.id(attendeeId);
  if (!attendee) {
    res.status(404);
    throw new Error('Attendee not found');
  }

  // Check if not checked in
  if (!attendee.checkedIn) {
    res.status(400);
    throw new Error('Attendee is not checked in');
  }

  // Update check-in status
  attendee.checkedIn = false;
  attendee.checkInTime = null;
  attendee.checkedInBy = null;

  // Update ticket check-in status
  ticket.checkInStatus = 'confirmed';

  await ticket.save();

  res.json({ 
    success: true, 
    message: 'Check-in undone', 
    ticket 
  });
});

// @desc    Bulk check-in/out for a ticket
// @route   PATCH /api/events/:eventId/paid/bulk-checkin/:ticketId
// @access  Private (organizer only)
export const bulkCheckInPaidTicket = asyncHandler(async (req, res) => {
  const { eventId, ticketId } = req.params;
  const { checkIn } = req.body; // boolean: true for check-in, false for check-out
  const userId = req.user._id;

  // Find the ticket and verify authorization
  const ticket = await PaidTicket.findOne({ _id: ticketId, event: eventId });
  if (!ticket) {
    res.status(404);
    throw new Error('Ticket not found');
  }

  // Check if user is the organizer using eventSnapshot
  if (ticket.eventSnapshot?.postedBy !== userId.toString()) {
    res.status(403);
    throw new Error('Not authorized to check in attendees for this event');
  }

  // Update all attendees
  const checkInTime = checkIn ? new Date() : null;
  ticket.attendees.forEach(attendee => {
    attendee.checkedIn = checkIn;
    attendee.checkInTime = checkInTime;
    attendee.checkedInBy = checkIn ? userId : null;
  });

  // Update ticket check-in status
  ticket.checkInStatus = checkIn ? 'checked-in' : 'confirmed';

  await ticket.save();

  res.json({ 
    success: true, 
    message: checkIn ? 'All attendees checked in' : 'All check-ins undone',
    ticket 
  });
});

// @desc    Check in attendee by QR code scan
// @route   POST /api/events/:eventId/paid/checkin-by-qr
// @access  Private (organizer only)
export const checkInByQRCode = asyncHandler(async (req, res) => {
  const { ticketNumber } = req.body;
  const { eventId } = req.params;
  const userId = req.user._id;

  console.log('📷 QR Check-in attempt - Ticket:', ticketNumber, 'Event:', eventId);

  if (!ticketNumber) {
    return res.status(400).json({
      success: false,
      errorCode: 'TICKET_NUMBER_REQUIRED',
      message: 'Ticket number is required'
    });
  }

  try {
    const ticket = await PaidTicket.findOne({ ticketNumber });
    
    if (!ticket) {
      console.log('❌ Ticket not found:', ticketNumber);
      return res.status(404).json({
        success: false,
        errorCode: 'TICKET_NOT_FOUND',
        message: 'Ticket not found'
      });
    }

    if (ticket.event !== eventId) {
      console.log('❌ Wrong event - Ticket belongs to:', ticket.eventSnapshot?.title);
      return res.status(400).json({
        success: false,
        errorCode: 'WRONG_EVENT',
        message: 'This ticket is not for this event',
        eventTitle: ticket.eventSnapshot?.title || 'Unknown Event',
        eventDate: ticket.eventSnapshot?.dateTime
      });
    }

    if (ticket.eventSnapshot?.postedBy !== userId.toString()) {
      console.log('❌ Not authorized - user is not organizer');
      return res.status(403).json({
        success: false,
        errorCode: 'NOT_AUTHORIZED',
        message: 'Not authorized to check in attendees for this event'
      });
    }

    if (ticket.checkInStatus === 'cancelled') {
      console.log('❌ Ticket cancelled');
      return res.status(400).json({
        success: false,
        errorCode: 'TICKET_CANCELLED',
        message: 'This ticket has been cancelled',
        buyerName: `${ticket.buyer?.firstName || ''} ${ticket.buyer?.lastName || ''}`.trim()
      });
    }

    const attendee = ticket.attendees[0];
    if (!attendee) {
      return res.status(500).json({
        success: false,
        errorCode: 'SERVER_ERROR',
        message: 'Invalid ticket structure'
      });
    }

    if (attendee.checkedIn) {
      console.log('❌ Already checked in at:', attendee.checkInTime);
      return res.status(400).json({
        success: false,
        errorCode: 'ALREADY_CHECKED_IN',
        message: 'Attendee already checked in',
        checkInTime: attendee.checkInTime,
        buyerName: `${ticket.buyer?.firstName || ''} ${ticket.buyer?.lastName || ''}`.trim(),
        ticketNumber: ticket.ticketNumber,
        ticketType: ticket.ticketType?.name
      });
    }

    const updatedTicket = await PaidTicket.findOneAndUpdate(
      { 
        _id: ticket._id,
        'attendees.0.checkedIn': false
      },
      { 
        $set: { 
          'attendees.0.checkedIn': true,
          'attendees.0.checkInTime': new Date(),
          'attendees.0.checkedInBy': userId,
          checkInStatus: 'checked-in'
        } 
      },
      { new: true }
    );

    if (!updatedTicket) {
      console.log('❌ Concurrent check-in detected');
      return res.status(409).json({
        success: false,
        errorCode: 'CONCURRENT_CHECKIN',
        message: 'This ticket was just checked in by another device'
      });
    }

    console.log('✅ Check-in successful:', ticketNumber);
    
    res.status(200).json({
      success: true,
      message: 'Attendee checked in successfully',
      ticket: {
        ticketNumber: updatedTicket.ticketNumber,
        buyerName: `${updatedTicket.buyer?.firstName || ''} ${updatedTicket.buyer?.lastName || ''}`.trim(),
        ticketType: updatedTicket.ticketType?.name,
        seats: updatedTicket.seats,
        checkInTime: updatedTicket.attendees[0].checkInTime
      }
    });

  } catch (error) {
    console.error('❌ QR Check-in error:', error);
    res.status(500).json({
      success: false,
      errorCode: 'SERVER_ERROR',
      message: 'Failed to process check-in',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

export default {
  getManagedPaidEvents,
  getPaidEventAttendees,
  checkinPaidEvent,
  undoCheckinPaidEvent,
  bulkCheckInPaidTicket,
  checkInByQRCode
};