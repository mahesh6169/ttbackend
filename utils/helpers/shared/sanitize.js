import sanitizeHtml from 'sanitize-html';

/**
 * Strip HTML tags from text to prevent XSS
 * @param {string} text - Input text
 * @returns {string} Cleaned text without HTML tags
 */
export const stripHtml = (text) => {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/<[^>]*>/g, '').trim();
};

// ─── Thread rich-text sanitisation (featureplans/threads-rich-editor.md) ─────────────────────────
// The editor is politeness; this is the wall. A crafted API request that bypasses the toolbar must
// come out clean. Allowlist mirrors the toolbar exactly.

// Does the string contain any real HTML tag? Genuinely tag-free plain text (legacy threads) is left
// byte-identical; anything with a tag (allowlisted OR crafted like <script>) goes through the wall.
const hasHtmlTag = (s) => /<\/?[a-z][^>]*>/i.test(s);

const THREAD_SANITIZE_CONFIG = {
  allowedTags: ['p', 'br', 'strong', 'em', 'u', 's', 'ul', 'ol', 'li', 'a'],
  allowedAttributes: { a: ['href', 'target', 'rel'] },
  // Links are https ONLY. http / javascript: / data: anchors are unwrapped to plain text below.
  allowedSchemes: ['https'],
  allowedSchemesByTag: { a: ['https'] },
  allowProtocolRelative: false,
  // Unknown tags (div, iframe, ...) are discarded but their text is kept; script/style content is
  // dropped entirely (sanitize-html's default nonTextTags).
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (tagName, attribs) => {
      const href = (attribs.href || '').trim();
      if (!/^https:\/\//i.test(href)) {
        // Non-https link (http, javascript:, none): unwrap to plain text. Renaming to a non-allowlisted
        // tag makes 'discard' mode drop the tag while keeping its text.
        return { tagName: 'span', attribs: {} };
      }
      // Every surviving https link opens safely in a new tab, regardless of what the client sent.
      return { tagName: 'a', attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } };
    },
  },
};

/**
 * Sanitise a thread's rich-text description against the locked allowlist.
 * Tag-free plain text (legacy content) is returned unchanged; tagged content is filtered.
 * @param {string} input
 * @returns {string}
 */
export const sanitizeThreadHtml = (input) => {
  if (input == null) return input;
  const str = String(input);
  if (!hasHtmlTag(str)) return str; // legacy plain text — untouched bytes
  return sanitizeHtml(str, THREAD_SANITIZE_CONFIG);
};

/**
 * Visible text length of a thread description (HTML wrapping excluded), for the 15,000 cap.
 * @param {string} input
 * @returns {number}
 */
export const threadTextLength = (input) => {
  const str = String(input ?? '');
  if (!hasHtmlTag(str)) return str.length;
  // Strip every tag, keep the text a reader would actually see.
  return sanitizeHtml(str, { allowedTags: [], allowedAttributes: {} }).length;
};
