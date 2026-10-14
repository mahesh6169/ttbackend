import jwt from 'jsonwebtoken';
import User from '../models/userModel.js';
import asyncHandler from 'express-async-handler';

/**
 * Optional auth middleware - checks for user but doesn't block if not present
 * Useful for public routes that show different content based on login status
 */
const optionalAuthMiddleware = asyncHandler(async (req, res, next) => {
  const token = req.cookies?.token;

  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.id).select('-password');
    if (user) {
      req.user = user; // ✅ Set req.user if valid
    } else {
      req.user = null;
    }
    next();
  } catch (error) {
    // Invalid/expired token, just continue without user
    req.user = null;
    next();
  }
});

export default optionalAuthMiddleware;
