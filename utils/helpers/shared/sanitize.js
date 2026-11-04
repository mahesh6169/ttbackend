import sanitizeHtml from 'sanitize-html';
import { isThreadPictureUrl } from './threadPictures.js';

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

// Feature 1012 (blog-style threads): adds headings (h2 Heading, h3 Subheading) and picture blocks
// (<div data-pictures> holding <img>). An <img> survives ONLY when its src is one of our own thread
// uploads (isThreadPictureUrl); width/height are kept as plain numbers so the page can reserve space.
const THREAD_SANITIZE_CONFIG = {
  allowedTags: ['p', 'br', 'strong', 'em', 'u', 's', 'ul', 'ol', 'li', 'a', 'h2', 'h3', 'div', 'img'],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    div: ['data-pictures'],
    img: ['src', 'alt', 'width', 'height'],
  },
  // Links are https ONLY. http / javascript: / data: anchors are unwrapped to plain text below.
  allowedSchemes: ['https'],
  allowedSchemesByTag: { a: ['https'], img: ['https'] },
  allowProtocolRelative: false,
  // Unknown tags (iframe, h1, ...) are discarded but their text is kept; script/style content is
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
    // Only a picture block survives as a div; any other div is unwrapped (its text kept).
    div: (tagName, attribs) =>
      Object.prototype.hasOwnProperty.call(attribs, 'data-pictures')
        ? { tagName: 'div', attribs: { 'data-pictures': '' } }
        : { tagName: 'span', attribs: {} },
    img: (tagName, attribs) => {
      const num = (v) => {
        const n = parseInt(String(v ?? ''), 10);
        return Number.isFinite(n) && n > 0 && n <= 10000 ? String(n) : undefined;
      };
      const out = { src: (attribs.src || '').trim(), alt: String(attribs.alt || '').slice(0, 200) };
      const w = num(attribs.width);
      const h = num(attribs.height);
      if (w) out.width = w;
      if (h) out.height = h;
      return { tagName: 'img', attribs: out };
    },
  },
  // Drop any picture that is not one of our own thread uploads (other sites, other folders, data:).
  exclusiveFilter: (frame) => frame.tag === 'img' && !isThreadPictureUrl(frame.attribs.src),
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
