import User from '../../../models/userModel.js';
import Advert from '../../../models/advertModel.js';
import Event from '../../../models/eventModel.js';
import Thread from '../../../models/threadModel.js';
import ThreadMessage from '../../../models/threadMessageModel.js';
import Message from '../../../models/messageModel.js';
import FreeTicket from '../../../models/freeTicket.js';
import cloudinary from '../../../utils/cloudinary.js';



export const deleteAdvertsByUser = async (userId) => {
  try {
    const adverts = await Advert.find({ postedBy: userId });
    const advertIds = adverts.map(ad => ad._id);

    // Delete all messages related to user's adverts
    if (advertIds.length > 0) {
      const messageDeleteResult = await Message.deleteMany({ 
        relatedTo: 'advert', 
        advert: { $in: advertIds } 
      });
      console.log(`💬 Deleted ${messageDeleteResult.deletedCount} messages for ${advertIds.length} adverts`);
    }

    // Remove adverts from all users' wishlists
    if (advertIds.length > 0) {
      const wishlistUpdateResult = await User.updateMany(
        { wishlist: { $in: advertIds } },
        { $pull: { wishlist: { $in: advertIds } } }
      );
      console.log(`❤️ Removed adverts from ${wishlistUpdateResult.modifiedCount} user wishlists`);
    }

    const FALLBACK_PUBLIC_ID =
      process.env.FALLBACK_ADVERT_IMAGE_PUBLIC_ID || 'tagtelugudev/assets/No_Image_Available_mq5h6q';

    // Delete images from Cloudinary
    for (const advert of adverts) {
      if (advert.images && advert.images.length > 0) {
        for (const image of advert.images) {
          if (image.publicId !== FALLBACK_PUBLIC_ID) {
            try {
              await cloudinary.uploader.destroy(image.publicId);
            } catch (cloudErr) {
              console.error(`❌ Failed to delete image ${image.publicId}:`, cloudErr.message);
            }
          } else {
            console.log(`ℹ️ Skipping fallback image: ${image.publicId}`);
          }
        }
      }
    }

    const deleteResult = await Advert.deleteMany({ postedBy: userId });
    console.log(`✅ Deleted ${deleteResult.deletedCount} adverts for user ${userId}`);
    return { success: true, deletedCount: deleteResult.deletedCount };
  } catch (error) {
    console.error('❌ Error deleting adverts by user:', error);
    throw new Error('Failed to delete adverts by user.');
  }
};

export const deleteEventsByUser = async (userId) => {
    try {
      const events = await Event.find({ postedBy: userId });
      const allEventIds = [];
      
      // Collect all event IDs including child events
      for (const event of events) {
        allEventIds.push(event._id);
        
        // If it's a recurring parent event, find all child events
        if (event.recurrence?.isRecurring && !event.recurrence?.parentEventId) {
          const childEvents = await Event.find({ 'recurrence.parentEventId': event._id }).select('_id');
          const childIds = childEvents.map(child => child._id);
          allEventIds.push(...childIds);
          console.log(`📋 Found ${childIds.length} child instances for recurring event ${event._id}`);
        }
      }

      // Delete all messages related to events
      if (allEventIds.length > 0) {
        const messageDeleteResult = await Message.deleteMany({ 
          relatedTo: 'event', 
          event: { $in: allEventIds } 
        });
        console.log(`💬 Deleted ${messageDeleteResult.deletedCount} messages for ${allEventIds.length} events`);
      }

      // Remove events from all users' event wishlists
      if (allEventIds.length > 0) {
        const wishlistUpdateResult = await User.updateMany(
          { eventWishlist: { $in: allEventIds } },
          { $pull: { eventWishlist: { $in: allEventIds } } }
        );
        console.log(`❤️ Removed events from ${wishlistUpdateResult.modifiedCount} user event wishlists`);
      }

      // Delete all free tickets for these events
      if (allEventIds.length > 0) {
        const ticketDeleteResult = await FreeTicket.deleteMany({ 
          event: { $in: allEventIds } 
        });
        console.log(`🎫 Deleted ${ticketDeleteResult.deletedCount} free tickets for ${allEventIds.length} events`);
      }
  
      const FALLBACK_PUBLIC_ID =
        process.env.FALLBACK_EVENT_IMAGE_PUBLIC_ID || 'tagtelugudev/assets/No_Image_Available_mq5h6q';
  
      // Delete images from Cloudinary
      for (const event of events) {
        if (event.images && event.images.length > 0) {
          for (const image of event.images) {
            if (image.publicId !== FALLBACK_PUBLIC_ID) {
              try {
                await cloudinary.uploader.destroy(image.publicId);
              } catch (cloudErr) {
                console.error(`❌ Failed to delete image ${image.publicId}:`, cloudErr.message);
              }
            } else {
              console.log(`ℹ️ Skipping fallback image: ${image.publicId}`);
            }
          }
        }
      }
  
      // Delete all events (parent and child)
      const deleteResult = await Event.deleteMany({ 
        $or: [
          { postedBy: userId },
          { _id: { $in: allEventIds } }
        ]
      });
      console.log(`✅ Deleted ${deleteResult.deletedCount} events (including child events) for user ${userId}`);
      return { success: true, deletedCount: deleteResult.deletedCount };
    } catch (error) {
      console.error('❌ Error deleting events by user:', error);
      throw new Error('Failed to delete events by user.');
    }
  };

  export const deleteThreadsByUser = async (userId) => {
    try {
      const threads = await Thread.find({ owner: userId });
      const threadIds = threads.map(thread => thread._id);
  
      // Delete all thread messages
      if (threadIds.length > 0) {
        const messageDeleteResult = await ThreadMessage.deleteMany({ thread: { $in: threadIds } });
        console.log(`💬 Deleted ${messageDeleteResult.deletedCount} thread messages for ${threadIds.length} threads`);
      }

      // Remove thread IDs from mutedThreads in all users
      if (threadIds.length > 0) {
        const muteUpdateResult = await User.updateMany(
          { mutedThreads: { $in: threadIds } },
          { $pull: { mutedThreads: { $in: threadIds } } }
        );
        console.log(`🔕 Removed threads from ${muteUpdateResult.modifiedCount} users' muted lists`);
      }

      const FALLBACK_PUBLIC_ID =
        process.env.FALLBACK_THREAD_IMAGE_PUBLIC_ID || 'tagtelugudev/assets/No_Image_Available_mq5h6q';
  
      // Delete images from Cloudinary
      for (const thread of threads) {
        if (thread.images && thread.images.length > 0) {
          for (const image of thread.images) {
            if (image.publicId !== FALLBACK_PUBLIC_ID) {
              try {
                await cloudinary.uploader.destroy(image.publicId);
              } catch (cloudErr) {
                console.error(`❌ Failed to delete thread image ${image.publicId}:`, cloudErr.message);
              }
            } else {
              console.log(`ℹ️ Skipping fallback thread image: ${image.publicId}`);
            }
          }
        }
      }
  
      // Delete the threads themselves
      const deleteResult = await Thread.deleteMany({ owner: userId });
      console.log(`✅ Deleted ${deleteResult.deletedCount} threads for user ${userId}`);
  
      return { success: true, deletedCount: deleteResult.deletedCount };
    } catch (error) {
      console.error('❌ Error deleting threads by user:', error);
      throw new Error('Failed to delete threads by user.');
    }
  };

  export const deleteConversationsByUser = async (userId) => {
    try {
      const messages = await Message.find({
        $or: [{ owner: userId }, { participant: userId }],
      });
  
      if (messages.length === 0) {
        console.log(`ℹ️ No conversations found for user ${userId}`);
        return { success: true, deletedCount: 0 };
      }
  
      // ✅ Only mark the message as deleted by the current user
      for (const msg of messages) {
        if (!msg.deletedBy.includes(userId)) {
          await Message.updateOne(
            { _id: msg._id },
            { $addToSet: { deletedBy: userId } }
          );
        }
      }
  
      console.log(`✅ Marked ${messages.length} messages as deleted for user ${userId} (soft delete only).`);
      return { success: true, markedCount: messages.length };
    } catch (error) {
      console.error('❌ Error marking conversations as deleted by user:', error);
      throw new Error('Failed to mark conversations as deleted by user.');
    }
  };
  
  