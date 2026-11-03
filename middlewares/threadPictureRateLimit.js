// Per-user limit for thread picture uploads (feature 1012). A thread holds at most 10 pictures, so
// 60 uploads an hour leaves room for retries and edits while stopping anyone filling the image store.
// In-memory like couponRateLimit.js: correct for the single Fly machine; move to a shared store if the
// backend ever runs on several machines. Must run AFTER authMiddleware (keys on req.user).

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX = 60;

const hits = new Map(); // userId -> { count, resetAt }

const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of hits) {
    if (now > bucket.resetAt) hits.delete(key);
  }
}, 10 * 60 * 1000);
if (sweep.unref) sweep.unref();

export const threadPictureLimiter = (req, res, next) => {
  const key = String(req.user?._id || req.user?.id || 'anon');
  const now = Date.now();
  let bucket = hits.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    hits.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > MAX) {
    res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
    return res.status(429).json({ message: 'Too many picture uploads. Please try again later.' });
  }
  next();
};
