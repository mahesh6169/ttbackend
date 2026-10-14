// Minimal in-memory per-IP rate limiter for the PUBLIC coupon endpoints
// (validate + redeem). No external dependency.
//
// Each store's codes are only 5 digits, so throttling is what makes brute-force
// enumeration impractical. ~30 attempts/min/IP is plenty for a real store worker
// (validate + redeem = 2 calls per customer) but useless for guessing.
//
// NOTE: the counter lives in this process's memory — correct for a single backend
// instance. If the backend ever scales to multiple instances, move this to a shared
// store (e.g. Redis) so the limit is enforced across them.

const WINDOW_MS = 60 * 1000; // 1 minute
const MAX = 30;              // attempts per window per IP

const hits = new Map(); // ip -> { count, resetAt }

// Periodically drop expired buckets so the map can't grow unbounded
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of hits) {
    if (now > bucket.resetAt) hits.delete(key);
  }
}, WINDOW_MS);
if (sweep.unref) sweep.unref(); // don't keep the process alive for this

// Real client IP. Behind Fly's proxy (no `trust proxy` set) req.ip is the proxy,
// so read the first entry of X-Forwarded-For instead.
const clientIp = (req) => {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
};

export const couponRedeemLimiter = (req, res, next) => {
  const key = clientIp(req);
  const now = Date.now();

  let bucket = hits.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    hits.set(key, bucket);
  }

  bucket.count += 1;

  res.setHeader('RateLimit-Limit', MAX);
  res.setHeader('RateLimit-Remaining', Math.max(0, MAX - bucket.count));

  if (bucket.count > MAX) {
    res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
    return res.status(429).json({
      success: false,
      message: 'Too many attempts. Please wait a moment and try again.'
    });
  }

  next();
};
