import asyncHandler from 'express-async-handler';
import { SITEMAP_SOURCES } from '../../utils/seo/sitemapFilters.js';

// @desc    Per child sitemap: how many items it lists and when the newest one last changed
// @route   GET /api/sitemap/summary
// @access  Public (x-api-key)
// Used by the frontend sitemap index (app/sitemap.xml) to leave out empty child sitemaps and
// to give each one an honest <lastmod>. Uses the SAME filters as the child sitemap feeds.
// Shape: { listings: { count, lastmod }, events: {...}, threads, deals, coupons };
// lastmod is an ISO date string, or null when the list is empty.
export const getSitemapSummary = asyncHandler(async (req, res) => {
  try {
    const entries = await Promise.all(
      Object.entries(SITEMAP_SOURCES).map(async ([key, { model, filter }]) => {
        const query = filter();
        const [count, newest] = await Promise.all([
          model.countDocuments(query),
          model.findOne(query).sort({ updatedAt: -1 }).select('updatedAt').lean(),
        ]);
        const lastmod = newest?.updatedAt ? new Date(newest.updatedAt).toISOString() : null;
        return [key, { count, lastmod }];
      })
    );
    return res.status(200).json(Object.fromEntries(entries));
  } catch (error) {
    console.error('Error building sitemap summary:', error.message);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});
