import axios from 'axios';

// Asks the frontend to drop its cached copy of a page (Next.js revalidateTag), so a link shared
// right after an edit shows the new title/image in WhatsApp/Facebook previews.
// Tags: event-<id>, listing-<id>, thread-<id>, deal-<id>, campaign-<slug> (see the frontend's
// app/api/revalidate/route.js). Awaited by callers so the cache is fresh before the save reply,
// but it never throws: a failed refresh only means the page updates when its cache expires.
export const refreshFrontendCache = async (tags) => {
  const secret = process.env.REVALIDATION_SECRET;
  const baseUrl = process.env.REVALIDATE_URL || process.env.FRONTEND_URL;
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
