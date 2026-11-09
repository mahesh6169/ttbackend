import axios from 'axios';

// Asks the frontend to drop its cached copy of a page (Next.js revalidateTag), so a link shared
// right after an edit shows the new title/image in WhatsApp/Facebook previews.
// Tags: event-<id>, listing-<id>, thread-<id>, deal-<id>, campaign-<slug>, and the *-list tags below (see the
// frontend's app/api/revalidate/route.js). Awaited by callers so the cache is fresh before the save reply,
// but it never throws: a failed refresh only means the page updates when its cache expires.
// The forum landing's first page and the home page's latest threads (feature 1012).
export const THREADS_LIST_TAG = 'threads-list';
// Section landings, so a new/changed/removed item shows there straight away (feature 1014).
// events-list and listings-list also cover the home page's events and listings strips.
export const EVENTS_LIST_TAG = 'events-list';
export const LISTINGS_LIST_TAG = 'listings-list';
export const DEALS_LIST_TAG = 'deals-list';
export const COUPONS_LIST_TAG = 'coupons-list';

export const refreshFrontendCache = async (tags) => {
  const secret = process.env.REVALIDATION_SECRET;
  // FRONTEND_URL is the comma-separated CORS list (app.js) - its first entry is the site itself.
  const baseUrl = (process.env.REVALIDATE_URL || process.env.FRONTEND_URL || '').split(',')[0].trim();
  const list = [...new Set((Array.isArray(tags) ? tags : [tags]).filter(Boolean))];

  if (!secret || !baseUrl || list.length === 0) return;

  await Promise.all(
    list.map((tag) =>
      axios
        .post(
          `${baseUrl.replace(/\/$/, '')}/api/revalidate`,
          { tag },
          { headers: { 'x-revalidation-secret': secret }, timeout: 3000 }
        )
        .catch((err) => {
          console.error(`Failed to refresh frontend cache for ${tag}:`, err.message);
        })
    )
  );
};
