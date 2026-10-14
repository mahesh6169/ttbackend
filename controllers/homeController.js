import asyncHandler from 'express-async-handler';
import Advert from '../models/advertModel.js';
import Event from '../models/eventModel.js';
import Thread from '../models/threadModel.js';
import { sendSuccess, sendError } from '../utils/response/responseUtil.js';

export const getHomeListings = asyncHandler(async (req, res) => {
  console.log('🏠 Fetching home listings');
  
  try {
    const listings = await Advert.find({ 
      status: 'active' 
    })
    .select('title slug images address.suburb address.state')
    .sort({ createdAt: -1 })
    .limit(9)
    .lean();
    
    const transformed = listings.map(item => ({
      _id: item._id,
      title: item.title,
      image: item.images?.[0]?.url || null,
      suburb: item.address?.suburb || 'N/A',
      state: item.address?.state || 'N/A',
      slug: item.slug || item._id
    }));
    
    console.log(`✅ Found ${transformed.length} listings for homepage`);
    return sendSuccess(res, 'Home listings fetched successfully', { listings: transformed });
    
  } catch (error) {
    console.error('❌ Error fetching home listings:', error);
    return sendError(res, 'Failed to fetch home listings', error);
  }
});

export const getHomeEvents = asyncHandler(async (req, res) => {
  console.log('🏠 Fetching home events');
  
  try {
    const now = new Date();
    
    console.log('🏠 Home events query - excluding demo events');

    const events = await Event.find({
      status: 'active',
      goLive: true,
      dateTime: { $gte: now },
      demo: { $ne: true },
      deletedByOrganiser: { $ne: true }, // organiser-cancelled events never show on the homepage (events-past-events.md)
      isBlocked: { $ne: true } // moderation-blocked events never show either (events-delete-retention.md D5)
    })
    .select('title slug images venue dateTime')
    .sort({ dateTime: 1 })
    .limit(9)
    .lean();
    
    const transformed = events.map(item => ({
      _id: item._id,
      title: item.title,
      image: item.images?.[0]?.url || null,
      venue: item.venue || 'Venue TBA',
      date: item.dateTime,
      slug: item.slug || item._id
    }));
    
    console.log(`✅ Found ${transformed.length} events for homepage`);
    return sendSuccess(res, 'Home events fetched successfully', { events: transformed });
    
  } catch (error) {
    console.error('❌ Error fetching home events:', error);
    return sendError(res, 'Failed to fetch home events', error);
  }
});

export const getHomeDemoEvents = asyncHandler(async (req, res) => {
  console.log('🎭 Fetching home demo events');

  try {
    const now = new Date();

    const events = await Event.find({
      status: 'active',
      goLive: true,
      dateTime: { $gte: now },
      demo: true
    })
    .select('title slug images venue dateTime')
    .sort({ dateTime: 1 })
    .limit(9)
    .lean();

    const transformed = events.map(item => ({
      _id: item._id,
      title: item.title,
      image: item.images?.[0]?.url || null,
      venue: item.venue || 'Venue TBA',
      date: item.dateTime,
      slug: item.slug || item._id
    }));

    console.log(`✅ Found ${transformed.length} demo events for homepage`);
    return sendSuccess(res, 'Home demo events fetched successfully', { events: transformed });

  } catch (error) {
    console.error('❌ Error fetching home demo events:', error);
    return sendError(res, 'Failed to fetch home demo events', error);
  }
});

export const getHomeThreads = asyncHandler(async (req, res) => {
  console.log('🏠 Fetching home threads');
  
  try {
    const threads = await Thread.find({})
    .select('title slug owner createdAt')
    .populate('owner', 'name')
    .sort({ createdAt: -1 })
    .limit(9)
    .lean();
    
    const transformed = threads.map(item => ({
      _id: item._id,
      title: item.title,
      author: item.owner?.name || 'Anonymous',
      createdAt: item.createdAt,
      slug: item.slug || item._id
    }));
    
    console.log(`✅ Found ${transformed.length} threads for homepage`);
    return sendSuccess(res, 'Home threads fetched successfully', { threads: transformed });
    
  } catch (error) {
    console.error('❌ Error fetching home threads:', error);
    return sendError(res, 'Failed to fetch home threads', error);
  }
});
