// Title quality rules for listings — see designGuides/SEO/detailspage/title-quality.md (T1).
// This is the backend enforcement copy: only `.error` (the BLOCK rules) is used here.
// `warnings` are frontend-only guidance — computed but ignored on the server; kept so
// this file stays byte-identical to the frontend twin and is trivial to keep in sync.
//
// KEEP IN SYNC with the frontend twin:
//   ttfrontend/utils/validateTitle.js
// (frontend on Vercel and backend on Fly.io are separate deployments, so this logic
//  is duplicated by hand — same pattern as generateSlug.)

export const TITLE_MIN = 6;
export const TITLE_MAX = 100;

// Characters allowed inside a title: letters, numbers, spaces and a small set
// of meaningful punctuation.
const ALLOWED_TITLE = /^[a-zA-Z0-9 \-&',().\/+]+$/;

/**
 * Validate a listing title.
 * @returns {{ error: string|null, warnings: string[] }}
 *   error    — first blocking failure (null if the title passes all block rules)
 *   warnings — non-blocking guidance (frontend only; ignored by the backend)
 */
export function validateTitle(raw) {
  const title = (raw || '').trim();
  const warnings = [];

  // ---- BLOCK rules (first failure wins) ----
  if (title === '') return { error: 'Title is required', warnings };
  if (title.length < TITLE_MIN)
    return { error: `Title is too short — use at least ${TITLE_MIN} characters.`, warnings };
  if (title.length > TITLE_MAX)
    return { error: `Title is too long — keep it under ${TITLE_MAX} characters.`, warnings };

  // Contact details don't belong in a title
  const hasEmail = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(title);
  const hasUrl = /(https?:\/\/|www\.)/i.test(title) || /\b[a-z0-9-]+\.(com|net|org|au|co|io)\b/i.test(title);
  const hasHandle = /(^|\s)@[a-z0-9._]+/i.test(title);
  const hasPhone = /\d{8,}/.test(title);
  if (hasEmail || hasUrl || hasHandle || hasPhone)
    return { error: 'Remove contact details (phone, email, website or @handle) from the title.', warnings };

  // English / Latin only — catches non-Latin scripts and emojis
  if (/[^\x00-\x7F]/.test(title))
    return { error: 'Use English letters only — remove emojis and non-English characters.', warnings };

  // Must contain an actual word
  if (!/[a-zA-Z]/.test(title))
    return { error: 'Title must include words, not just numbers and symbols.', warnings };

  // Only allowed punctuation
  if (!ALLOWED_TITLE.test(title))
    return { error: "Remove special characters — allowed: letters, numbers and - & ' , ( ) . / +", warnings };

  // No repeated punctuation such as !!! or ---
  if (/([^\w\s])\1/.test(title))
    return { error: 'Remove repeated punctuation such as !!! or ---.', warnings };

  // Must start and end with a letter or number
  if (/^[^a-zA-Z0-9]/.test(title) || /[^a-zA-Z0-9]$/.test(title))
    return { error: 'Title must start and end with a letter or number.', warnings };

  // ---- WARN rules (non-blocking, frontend only) ----
  const letters = title.replace(/[^a-zA-Z]/g, '');
  if (letters.length >= 2 && title === title.toUpperCase())
    warnings.push('Consider normal capitalisation instead of ALL CAPS.');

  const words = title.split(/\s+/).filter(Boolean);
  if (words.length < 3)
    warnings.push('Add a few more words so buyers know what it is and where.');

  if (title.includes('$') || /\b\d{3,}\b/.test(title))
    warnings.push('Consider moving the price to the price field.');

  const lower = words.map((w) => w.toLowerCase());
  if (new Set(lower).size < lower.length)
    warnings.push('Avoid repeating the same word.');

  return { error: null, warnings };
}
