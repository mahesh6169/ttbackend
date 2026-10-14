import jwt from 'jsonwebtoken';
import User from '../models/userModel.js';
import asyncHandler from 'express-async-handler';

const authMiddleware = asyncHandler(async (req, res, next) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ message: 'Authentication required. Please log in.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.id).select('-password');
    if (!user) {
      return res.status(401).json({ message: 'Invalid user. Please log in again.' });
    }

    req.user = user; // ✅ req.user will now have _id, email, role, etc.
    next();
  } catch (error) {
    res.status(401).json({ message: 'Invalid or expired token. Please log in again.' });
  }
});

export default authMiddleware;
