import fs from 'fs';
import path from 'path';

// Ensure log directory exists
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Log denied access to file
const logDeniedAccess = (req, reason) => {
  const logEntry = {
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.originalUrl || req.path,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    reason: reason,
    headers: {
      'x-api-key': req.headers['x-api-key'] ? 'provided' : 'missing'
    }
  };

  try {
    const logFile = path.join(__dirname, '../logs/api-key-access.log');
    const logLine = JSON.stringify(logEntry) + '\n';

    // Append to log file
    fs.appendFileSync(logFile, logLine);
  } catch (error) {
    console.error(`❌ [LOG-ERROR] Failed to write log: ${error.message}`);
  }
};

export const apiKeyAuth = (req, res, next) => {
  // Get current mode
  const mode = process.env.API_KEY_MODE || 'warn'; // off, warn, enforce
  
  // If mode is 'off', skip all checks
  if (mode === 'off') {
    return next();
  }
  
  // Only log if explicitly debugging
  if (process.env.DEBUG_API_KEY === 'verbose') {
    console.log(`[API-KEY-CHECK] ${req.method} ${req.originalUrl || req.path} - Headers:`, {
      'x-api-key': req.headers['x-api-key'] ? 'PROVIDED' : 'MISSING',
      'path': req.path,
      'originalUrl': req.originalUrl,
      'baseUrl': req.baseUrl
    });
  }

  // Always bypass these endpoints - based on actual route analysis
  const publicEndpoints = [
    // ===== BASE ROUTES =====
    '/',
    '/health',
    '/socket.io/',
    
    // ===== USER AUTH ROUTES (must be public for login/register) =====
    '/api/users/register',
    '/api/users/guest',
    '/api/users/login',
    '/api/users/validate',
    '/api/users/sendResetOtp',
    '/api/users/resetPassword',
    
    // ===== ADVERT ROUTES =====
    '/api/adverts/search',
    '/api/adverts/filter-options',
    '/api/adverts/byid/',  // + ID (dynamic)
    
    // ===== EVENT ROUTES =====
    // Search & Discovery
    '/api/events/search',
    '/api/events/filter-options',
    '/api/events/fetchAllEvents',
    '/api/events/views/',  // + ID (dynamic)
    
    // Filter endpoints
    '/api/events/filters/all',
    '/api/events/filters/categories',
    '/api/events/filters/locations',
    '/api/events/filters/customcategories',
    
    // Event capacity/seats (public for viewing)
    '/api/events/',  // Covers capacity and seats endpoints (dynamic)
    '/api/events/seats/check-availability',  // POST endpoint for checking specific seats
    
    // ===== THREAD ROUTES =====
    '/api/threads/',
    '/api/threads/public/',  // + ID (dynamic)
    '/api/threads/search',
    '/api/threads/filter-options',
    '/api/threads/recent-activity',
    '/api/threads/filters/',  // + filter type (dynamic)
    '/api/threads/message/',  // For likes/unlikes (dynamic)
    
    // ===== SUPPORT ROUTES =====
    '/api/support/report',
    '/api/support/contact',
    
    // ===== HOME ROUTES (Homepage Data) =====
    '/api/home/listings',
    '/api/home/events',
    '/api/home/threads',
    
    // ===== WEBHOOK ENDPOINTS =====
    '/api/stripe/webhook',
    '/api/stripe/webhook-test',
    '/api/mailersend/webhook',
    
    // ===== BANNER AD PUBLIC ROUTES =====
    '/api/bannerAds/serve/',      // + placement ID (dynamic)
    '/api/bannerAds/impression/',  // + ad ID (dynamic)
    '/api/bannerAds/click/',       // + ad ID (dynamic)
    '/api/bannerAds/setState',     // POST endpoint for setting state cookie
    '/api/bannerAds/clearState',   // POST endpoint for clearing state cookie
    '/api/bannerAds/getState',     // GET endpoint for checking state cookie
    
    // ===== ADMIN ROUTES =====
    '/api/admin/login',
    
    // ===== COUPON CODE PUBLIC ROUTES =====
    '/api/coupons/stores',
    '/api/coupons/stores/',
    '/api/coupons/stores/lookup/',
    '/api/coupons/validate',
    '/api/coupons/redeem',
    '/api/coupons/claim',

    // ===== DAILY DEALS PUBLIC ROUTES =====
    '/api/dailydeals',
    '/api/dailydeals/view/',  // + ID (dynamic) - for OG meta tags
    '/api/dailydeals/filter-options',
  ];
  
  // Use originalUrl to get the full path including /api prefix
  const fullPath = (req.originalUrl || req.path).split('?')[0];

  // Check if current path should be bypassed
  const isPublic = publicEndpoints.some(endpoint => {
    // Exact match first
    if (fullPath === endpoint || fullPath === endpoint.slice(0, -1)) {
      return true;
    }
    
    // Special handling for dynamic routes
    if (endpoint === '/api/adverts/byid/' && fullPath.startsWith('/api/adverts/byid/')) {
      return true;
    }
    
    if (endpoint === '/api/events/views/' && fullPath.startsWith('/api/events/views/')) {
      return true;
    }
    
    if (endpoint === '/api/threads/public/' && fullPath.startsWith('/api/threads/public/')) {
      return true;
    }

    if (endpoint === '/api/dailydeals/view/' && fullPath.startsWith('/api/dailydeals/view/')) {
      return true;
    }
    
    // For filter routes
    if (endpoint === '/api/threads/filters/' && fullPath.startsWith('/api/threads/filters/')) {
      return true;
    }
    
    if (endpoint === '/api/events/filters/' && fullPath.startsWith('/api/events/filters/')) {
      return true;
    }
    
    // Banner ad dynamic routes
    if (endpoint === '/api/bannerAds/serve/' && fullPath.startsWith('/api/bannerAds/serve/')) {
      return true;
    }
    
    if (endpoint === '/api/bannerAds/impression/' && fullPath.startsWith('/api/bannerAds/impression/')) {
      return true;
    }
    
    if (endpoint === '/api/bannerAds/click/' && fullPath.startsWith('/api/bannerAds/click/')) {
      return true;
    }
    
    // For thread message likes
    if (endpoint === '/api/threads/message/' && fullPath.includes('/api/threads/message/')) {
      return true;
    }
    
    // For event capacity/seats, and the public waitlist join (logged-out visitors have no key)
    if (endpoint === '/api/events/' && (
      fullPath.match(/^\/api\/events\/[^\/]+\/(capacity|seats)/) ||
      fullPath.match(/^\/api\/events\/[^\/]+\/seats\//) ||
      fullPath.match(/^\/api\/events\/[^\/]+\/waitlist\/join$/)
    )) {
      return true;
    }
    
    // For check-availability endpoint
    if (endpoint === '/api/events/seats/check-availability' && 
        fullPath.match(/^\/api\/events\/[^\/]+\/seats\/check-availability/)) {
      return true;
    }
    
    // Coupon code dynamic routes
    if (endpoint === '/api/coupons/stores/lookup/' && fullPath.startsWith('/api/coupons/stores/lookup/')) {
      return true;
    }
    
    if (endpoint === '/api/coupons/stores/' && fullPath.startsWith('/api/coupons/stores/') && 
        !fullPath.includes('/campaigns')) {
      return true;
    }
    
    return false;
  });
  
  if (isPublic) {
    return next();
  }

  const providedKey = req.headers['x-api-key'];
  const expectedKey = process.env.FRONTEND_API_KEY;

  // Check if key is valid
  const isValidKey = providedKey && providedKey === expectedKey;

  if (!isValidKey) {
    const reason = !providedKey ? 'missing-api-key' : 'invalid-api-key';
    
    // Log the denied access
    logDeniedAccess(req, reason);

    // Handle based on mode
    if (mode === 'warn') {
      console.warn(`⚠️ [WARN MODE] ${reason}: ${req.method} ${req.path} from ${req.ip}`);
      // In warn mode, we log but still allow the request
      return next();
    } else if (mode === 'enforce') {
      console.error(`❌ [ENFORCE MODE] ${reason}: ${req.method} ${req.path} from ${req.ip}`);
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or missing API key'
      });
    }
  }

  // Valid key - only log if verbose debugging
  if (process.env.DEBUG_API_KEY === 'verbose') {
    console.log(`✅ [API-KEY-VALID] ${req.method} ${fullPath} - Valid key provided`);
  }
  
  // Optionally log successful authentications too
  if (process.env.LOG_SUCCESSFUL_AUTH === 'true') {
    const successEntry = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: fullPath,
      ip: req.ip,
      result: 'success',
      userAgent: req.headers['user-agent']
    };
    
    const successLogFile = path.join(__dirname, '../logs/api-key-success.log');
    fs.appendFileSync(successLogFile, JSON.stringify(successEntry) + '\n');
  }
  
  next();
};

// Utility function to analyze deny logs
export const analyzeApiKeyLogs = () => {
  const logFile = process.env.API_KEY_LOG_FILE || './logs/api-key-access.log';
  
  if (!fs.existsSync(logFile)) {
    console.log('No deny logs found yet.');
    return;
  }

  const logs = fs.readFileSync(logFile, 'utf-8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));

  // Group by path
  const pathCounts = {};
  logs.forEach(log => {
    pathCounts[log.path] = (pathCounts[log.path] || 0) + 1;
  });

  console.log('\n📊 API Key Deny Analysis:');
  console.log('Total denied requests:', logs.length);
  console.log('\nDenied paths:');
  Object.entries(pathCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([path, count]) => {
      console.log(`  ${path}: ${count} denies`);
    });
};