import express from 'express';
import authMiddleware from '../middlewares/authMiddleware.js';
import optionalAuthMiddleware from '../middlewares/optionalAuthMiddleware.js';
import { joinWaitlist, getEventWaitlist, sendWaitlistNotification } from '../controllers/events/waitlistController.js';
import { multerMiddleware } from '../middlewares/multerConfig.js';

// Event Controllers
import {
  addFreeEvent,
  updateFreeEvent,
  addPaidEvent,
  updatePaidEvent,  
  fetchAllEvents,
  fetchEventById,
  getEventsByOrganiserSlug,
  fetchMyEvents,
  getPastEvents,
  deleteEvent,
  getEventCapacity,
  getSitemapEvents,
  toggleEventGoLive,
  toggleEventWaitlist,
} from '../controllers/events/eventController.js';

// Event Capacity Controller
import {
  getEventCapacityV2,
} from '../controllers/events/eventCapacityController.js';

import {
  getAllEvents,
  getEventsByCategory,
  getEventsByLocation,
  getEventsCustomCategory,
} from '../controllers/events/filterEventController.js';

import {
  searchEvents,
  getFilterOptions,
  searchDemoEvents,
} from '../controllers/events/searchEventController.js'; 

import {
  registerForFreeEvent,
  unregisterFromFreeEvent,
  cancelRegistrationByOrganiser,
  getFreeEventRegistrationStatus,
  fetchMyFreeRegistrations,
  checkinFreeEvent,
  undoCheckinFreeEvent,
  getEventAttendeesForCheckIn,
  getUserManagedFreeEvents,
  bulkCheckInRegistration
} from '../controllers/events/freeEventController.js'; 

import {
  getManagedPaidEvents,
  getPaidEventAttendees,
  checkinPaidEvent,
  undoCheckinPaidEvent,
  bulkCheckInPaidTicket,
  checkInByQRCode
} from '../controllers/events/paidEventCheckInController.js';

import { getUserEventsSummary } from '../controllers/events/userSummaryController.js';

// 🆕 Seat Selection Controllers
import {
  getSeatAvailability,
  validateReservationsForPayment,   
  checkSeatsAvailability,           
  getSeatDetail,                    
  bulkUpdateSeats,                  
  manualCleanupExpired,             
  getSeatStats,
  // New two-phase endpoints
  holdSeat,
  releaseSeatHold,
  createReservation,
  releaseReservation,
  getMyActiveReservation                      
} from '../controllers/events/seatController.js';

import {
  createPaymentIntent,
  confirmPayment,
  validateDiscount,
  getMyTickets,
  getMyAllPaidTickets,
  getTicketDetails,
  getAllEventTickets
} from '../controllers/events/ticketController.js';

import {
  processRefund,  // Unified refund function
  getRefundableTickets,
  getRefundableEvents  // 🆕 NEW: Import the new function
} from '../controllers/events/eventRefundController.js';

// 🆕 Invoice Controller
import {
  getInvoiceByNumber,
  getInvoiceByIdentifier,
  getUserInvoices
} from '../controllers/events/eventInvoiceController.js';

// 🆕 Reservation Controllers
import {
  createOrUpdateReservation,
  addSeatsToReservation,
  getReservation,
  deleteReservation,
  updateBuyerInfo,
  triggerCleanup
} from '../controllers/events/reservationController.js';

const router = express.Router();

// 🔍 Search & Filter Routes (Public)
router.get('/search', searchEvents);
router.get('/demo', searchDemoEvents);
router.get('/filter-options', getFilterOptions);
router.get('/sitemap', getSitemapEvents);

// 🟢 Filtering Routes (Public)
router.get('/filters/all', getAllEvents);                     // All mode
router.get('/filters/categories', getEventsByCategory);       // Categories mode (multi-category)
router.get('/filters/locations', getEventsByLocation);        // Location mode (location-based)
router.get('/filters/customcategories', getEventsCustomCategory);  // Custom categories mode

// Public organiser page: all of one organiser's published upcoming/running events (events-by-organiser.md)
router.get('/past', getPastEvents);                           // Public "Past events" list for /events
router.get('/by/:slug', getEventsByOrganiserSlug);

// 🟢 Public Event Routes
router.get('/fetchAllEvents', fetchAllEvents);               // Fetch all events
router.get('/views/:id', optionalAuthMiddleware, fetchEventById); // Fetch a single event by ID (optional auth: owner sees full discount codes, public sees hints only)
router.get('/:eventId/capacity', getEventCapacity);          // Get event capacity and remaining slots
router.get('/:eventId/capacity/v2', getEventCapacityV2);     // Get event capacity v2 - public (for views page)

// Protected capacity route for authenticated users (tickets/purchasing page)
router.get('/:eventId/capacity/v2/auth', authMiddleware, getEventCapacityV2);  // Get event capacity v2 - authenticated

// 🔒 Protected Event Management Routes
router.post('/add-free-event', authMiddleware, multerMiddleware, addFreeEvent);
router.put('/update-free/:id', authMiddleware, multerMiddleware, updateFreeEvent); 

// Paid Events
router.post('/add-paid-event', authMiddleware, multerMiddleware, addPaidEvent);
router.put('/update-paid/:id', authMiddleware, multerMiddleware, updatePaidEvent); 

router.get('/mine', authMiddleware, fetchMyEvents);           // 📝 For event management/editing
router.delete('/:id', authMiddleware, deleteEvent);          // Delete event
router.patch('/:id/toggle-golive', authMiddleware, toggleEventGoLive);  // Toggle goLive status
router.patch('/:id/toggle-waitlist', authMiddleware, toggleEventWaitlist);  // Toggle waitlist on/off

// 💰 Refund Management Routes (Organizer only)
router.get('/refunds/my-events', authMiddleware, getRefundableEvents);  // 🆕 NEW: Get events for refunds
router.post('/:eventId/refunds/process', authMiddleware, processRefund);  // Unified refund endpoint
router.get('/:eventId/refunds/eligible', authMiddleware, getRefundableTickets);

// 📋 Invoice Routes (Protected)
router.get('/invoices/my-invoices', authMiddleware, getUserInvoices); // Get all user invoices
router.get('/invoices/:invoiceNumber', authMiddleware, getInvoiceByNumber); // Get invoice by invoice number
router.get('/invoices/lookup/:identifier', authMiddleware, getInvoiceByIdentifier);

//Ticket Routes
// 🎫 Paid Ticket Routes (Following Free Event Pattern)
router.post('/:eventId/paid/create-payment-intent', authMiddleware, createPaymentIntent); // Create payment intent for tickets
router.post('/:eventId/paid/confirm-payment', authMiddleware, confirmPayment); // Confirm payment and create tickets
router.post('/:eventId/paid/validate-discount', authMiddleware, validateDiscount); // Validate a discount code at checkout (read-only)
router.get('/:eventId/paid/my-tickets', authMiddleware, getMyTickets); // Get user's tickets for this event
router.get('/:eventId/paid/all-tickets', authMiddleware, getAllEventTickets); 
router.get('/paid/my-paid-tickets', authMiddleware, getMyAllPaidTickets); // Get user's tickets across all events
router.get('/paid/ticket-details/:ticketNumber', authMiddleware, getTicketDetails); // Get ticket details by ticket number

// 📋 Per-domain user summary (events). Convention: GET /{resource}/user/summary
router.get('/user/summary', authMiddleware, getUserEventsSummary); // Upcoming events: hosting + attending, free + paid

// 🎫 Paid Event Check-in Routes
router.get('/user/managed/paid', authMiddleware, getManagedPaidEvents); // Get user's managed paid events
router.get('/:eventId/paid/attendees', authMiddleware, getPaidEventAttendees); // Get attendees for check-in
router.patch('/:eventId/paid/checkin/:ticketId', authMiddleware, checkinPaidEvent); // Check in attendee
router.patch('/:eventId/paid/undo-checkin/:ticketId', authMiddleware, undoCheckinPaidEvent); // Undo check-in
router.patch('/:eventId/paid/bulk-checkin/:ticketId', authMiddleware, bulkCheckInPaidTicket); // Bulk check-in/out
router.post('/:eventId/paid/checkin-by-qr', authMiddleware, checkInByQRCode); // QR code check-in

// 🆕 Seat Selection Routes (Protected)
router.get('/:eventId/seats', getSeatAvailability);                                    // ✅ Get seat layout
router.get('/:eventId/seats/my-reservations', authMiddleware, getMyActiveReservation); // ✅ Get active reservation
router.post('/:eventId/seats/validate-reservations', authMiddleware, validateReservationsForPayment); // ✅ Validate before payment

// 🆕 Two-Phase Seat Selection Routes (NEW)
router.post('/:eventId/seats/hold', authMiddleware, holdSeat);                        // ✅ Hold single seat (5 min)
router.delete('/:eventId/seats/hold', authMiddleware, releaseSeatHold);               // ✅ Release seat hold
// DEPRECATED - Using new reservation system instead
// router.post('/:eventId/seats/reserve', authMiddleware, createReservation);            // ✅ Create group reservation (10 min)
// router.delete('/:eventId/seats/reserve', authMiddleware, releaseReservation);         // ✅ Release group reservation

// 🆕 Additional Routes (Missing from your current routes)
router.post('/:eventId/seats/check-availability', checkSeatsAvailability);            // ✅ Check specific seats
router.get('/:eventId/seats/:seatId', getSeatDetail);                                 // ✅ Get seat details
router.put('/:eventId/seats/bulk-update', authMiddleware, bulkUpdateSeats);           // ✅ Admin bulk update
router.post('/:eventId/seats/cleanup', authMiddleware, manualCleanupExpired);         // ✅ Admin cleanup
router.get('/:eventId/seats/stats', authMiddleware, getSeatStats);                    // ✅ Admin statistics

// Free Events - Non-parameterized routes first
router.get('/free/my-free-registrations', authMiddleware, fetchMyFreeRegistrations);
router.get('/user/managed/free', authMiddleware, getUserManagedFreeEvents); // Get user's managed free events

// Free Events - Parameterized routes
router.post('/:eventId/waitlist/join', optionalAuthMiddleware, joinWaitlist);  // Public: join event waitlist
router.get('/:eventId/waitlist/entries', authMiddleware, getEventWaitlist);    // Organiser: list waitlist
router.post('/:eventId/waitlist/notify', authMiddleware, sendWaitlistNotification); // Organiser: send "tickets available"
router.post('/:eventId/free/register', authMiddleware, registerForFreeEvent);
router.delete('/:eventId/free/unregister', authMiddleware, unregisterFromFreeEvent);
router.delete('/:eventId/free/registration/:ticketId', authMiddleware, cancelRegistrationByOrganiser); // Organiser cancels any registration
router.get('/:eventId/free/registration-status', authMiddleware, getFreeEventRegistrationStatus);
router.get('/:eventId/free/attendees', authMiddleware, getEventAttendeesForCheckIn); // Get attendees for check-in
router.patch('/:eventId/free/checkin/:ticketId', authMiddleware, checkinFreeEvent);
router.patch('/:eventId/free/undo-checkin/:ticketId', authMiddleware, undoCheckinFreeEvent);
router.patch('/:eventId/free/bulk-checkin/:ticketId', authMiddleware, bulkCheckInRegistration); // Bulk check-in/out

// 🆕 Reservation Routes (merged from reservationRoutes.js)
// Cleanup route MUST come before parameterized routes
router.post('/:eventId/reservation/cleanup', authMiddleware, triggerCleanup);            // Trigger cleanup task

// Reservation routes
router.post('/:eventId/reservation', authMiddleware, createOrUpdateReservation);         // Create or update reservation
router.get('/:eventId/reservation', authMiddleware, getReservation);                     // Get active reservation
router.put('/:eventId/reservation/:id/seats', authMiddleware, addSeatsToReservation);   // Add seats to reservation
router.put('/:eventId/reservation/:id/buyer', authMiddleware, updateBuyerInfo);         // Update buyer info
router.delete('/:eventId/reservation/:id', authMiddleware, deleteReservation);           // Delete reservation

export default router;