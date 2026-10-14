// utils/events/deleteEventHelpers.js
// Cascade delete for a permanently-deleted event (events-delete-retention.md D2/D3).

import User from '../../models/userModel.js';
import WaitlistEntry from '../../models/waitlistEntry.js';
import Reservation from '../../models/reservationModel.js';
import mongoose from 'mongoose';

/**
 * Cascade delete for a permanently-deleted event.
 * Retains FreeTicket, PaidTicket, EventInvoice and RefundRequest - each carries its own event
 * snapshot, so they read back fine without the live Event doc. Removes waitlist entries and
 * seat holds (reservations), which otherwise point at an event that no longer exists, and pulls
 * the event(s) out of every user's wishlist. One path for both free and paid events - there is no
 * longer a meaningful difference between them here now that both retain their tickets.
 * @param {Object} event - The event document
 * @param {Array} childEventIds - Array of child event IDs (for recurring events)
 * @returns {Object} Summary of cascade delete operations
 */
export const cascadeDeleteEvent = async (event, childEventIds = []) => {
  if (!event || !event._id) {
    throw new Error('Invalid event object for cascade delete');
  }

  console.log(`🗑️  Starting cascade delete for event: ${event.title} (${event._id})`);
  if (childEventIds.length > 0) {
    console.log(`🗑️  Including ${childEventIds.length} child events in cascade delete`);
  }

  const deleteSummary = {
    waitlistEntries: 0,
    reservations: 0,
    wishlistRemovals: 0,
    preservedRecords: {
      freeTickets: true,
      paidTickets: true,
      eventInvoices: true,
      refundRequests: true,
    },
    errors: [],
  };

  const allEventIds = [event._id, ...childEventIds].map((id) =>
    mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id
  );

  try {
    const waitlistResult = await WaitlistEntry.deleteMany({ event: { $in: allEventIds } });
    deleteSummary.waitlistEntries = waitlistResult.deletedCount || 0;
    console.log(`✅ Deleted ${deleteSummary.waitlistEntries} waitlist entries`);

    const reservationResult = await Reservation.deleteMany({ eventId: { $in: allEventIds } });
    deleteSummary.reservations = reservationResult.deletedCount || 0;
    console.log(`✅ Deleted ${deleteSummary.reservations} seat holds (reservations)`);

    const updateWishlistResult = await User.updateMany(
      { eventWishlist: { $in: allEventIds } },
      { $pull: { eventWishlist: { $in: allEventIds } } }
    );
    deleteSummary.wishlistRemovals = updateWishlistResult.modifiedCount || 0;
    console.log(`✅ Removed ${allEventIds.length} event(s) from ${deleteSummary.wishlistRemovals} user wishlists`);

    console.log('📋 Cascade delete completed:', deleteSummary);
  } catch (error) {
    console.error('❌ Error in cascade delete for event:', error);
    deleteSummary.errors.push(error.message);
  }

  return deleteSummary;
};
