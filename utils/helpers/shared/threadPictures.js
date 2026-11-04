// Pictures inside a thread post (feature 1012).
//
// The editor stores pictures in the post HTML as picture blocks:
//   <div data-pictures=""><img src="https://res.cloudinary.com/<cloud>/image/upload/v1/<folder>/threads/<id>.jpg"
//        alt="" width="1600" height="1200"></div>
// One <img> = a single picture, several = a picture set. The sanitiser (sanitize.js) only lets
// through <img> whose src is one of OUR thread uploads (isThreadPictureUrl). The thread's images[]
// field is derived from the post on save, so cards, share previews and deletes keep working.

export const THREAD_PICTURE_LIMIT = 10;

const cloudName = () => process.env.CLOUDINARY_CLOUD_NAME || 'dtvrbdvkx';

// Same split the rest of the backend uses for Cloudinary folders.
export const threadPictureFolder = () =>
  `${process.env.NODE_ENV === 'production' ? 'tagtelugu' : 'tagtelugudev'}/threads`;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// https://res.cloudinary.com/<cloud>/image/upload/[v123/]<tagtelugu|tagtelugudev>/threads/<id>.<ext>
const pictureUrlRe = () =>
  new RegExp(
    `^https://res\\.cloudinary\\.com/${escapeRe(cloudName())}/image/upload/(?:v\\d+/)?` +
      '((?:tagtelugu|tagtelugudev)/threads/[A-Za-z0-9_-]+)\\.(?:jpe?g|png|webp)$'
  );

/** True when src is a picture uploaded through the thread picture endpoint. */
export const isThreadPictureUrl = (src) => typeof src === 'string' && pictureUrlRe().test(src.trim());

/** Cloudinary public id of a thread picture URL (null if it is not one). */
export const publicIdFromUrl = (src) => {
  const m = typeof src === 'string' ? src.trim().match(pictureUrlRe()) : null;
  return m ? m[1] : null;
};

/**
 * Pictures in (already sanitised) post HTML, in reading order, shaped like Thread.images entries.
 * @param {string} html
 * @returns {{url: string, publicId: string, originalFilename: string}[]}
 */
export const extractThreadPictures = (html) => {
  if (!html || typeof html !== 'string') return [];
  const out = [];
  const re = /<img\b[^>]*?\bsrc="([^"]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    const publicId = publicIdFromUrl(url);
    if (publicId) out.push({ url, publicId, originalFilename: '' });
  }
  return out;
};
