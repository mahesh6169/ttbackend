// Which items each sitemap advertises to Google (feature 1013).
// One place for the rule, so the per-type sitemap feeds (GET /api/<type>/sitemap) and the
// sitemap summary (GET /api/sitemap/summary, used for the sitemap index) always agree.
// Each function returns a fresh Mongo filter (dates are taken at call time).
import Advert from '../../models/advertModel.js';
import Event from '../../models/eventModel.js';
import Thread from '../../models/threadModel.js';
import DailyDeal from '../../models/dailydeals/dailyDeal.js';
import Campaign from '../../models/coupons/campaign.js';

// Live listings only: switched on (status 'active') and not past their expiry date.
// Expired / switched-off listings keep their page (the owner can renew) but are noindex.
export const listingsSitemapFilter = () => ({
  status: 'active',
  expiresAt: { $gte: new Date() },
});

// Upcoming events only. Left out: blocked by admin, switched off by the organiser (goLive
// false), and cancelled (deletedByOrganiser - the organiser's delete is a soft cancel).
export const eventsSitemapFilter = () => ({
  dateTime: { $gte: new Date() },
  isBlocked: { $ne: true },
  goLive: { $ne: false },
  deletedByOrganiser: { $ne: true },
});

// Threads have no live/not-live flag; a deleted thread is removed from the database.
export const threadsSitemapFilter = () => ({});

// Same active/online/date-range rule as the deals browse page.
export const dealsSitemapFilter = () => {
  const now = new Date();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return {
    isActive: true,
    isOnline: { $ne: false },
    startDate: { $lte: now },
    endDate: { $gte: startOfToday },
  };
};

export const couponsSitemapFilter = () => ({
  isActive: true,
  isHidden: false,
  expiryDate: { $gte: new Date() },
});

// The child sitemaps that hold database items, in sitemap-index order.
export const SITEMAP_SOURCES = {
  listings: { model: Advert, filter: listingsSitemapFilter },
  events: { model: Event, filter: eventsSitemapFilter },
  threads: { model: Thread, filter: threadsSitemapFilter },
  deals: { model: DailyDeal, filter: dealsSitemapFilter },
  coupons: { model: Campaign, filter: couponsSitemapFilter },
};
