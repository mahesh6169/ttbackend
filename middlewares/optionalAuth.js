import jwt from 'jsonwebtoken';
import User from '../models/userModel.js';

// Optional authentication middleware
// Attaches user to request if valid token exists, but doesn't require it
export const optionalAuth = async (req, res, next) => {
  try {
    // Extract token from cookie
    const token = req.cookies?.token;

    // If no token, continue without user
    if (!token) {
      return next();
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Find user and attach to request
    const user = await User.findById(decoded.id).select('-password');
    
    if (user) {
      req.user = user;
      console.log('[OptionalAuth] User attached:', user._id, 'State:', user.suburb?.state);
    }
    
    next();
  } catch (error) {
    // If token is invalid, continue without user
    console.log('[OptionalAuth] Token invalid, continuing without user');
    next();
  }
};