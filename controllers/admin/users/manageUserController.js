import asyncHandler from 'express-async-handler';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../../../models/userModel.js';
import { CURRENT_TERMS_VERSION } from '../../../constants/terms.js';
import * as deleteUserCascade from '../../../utils/helpers/users/deleteUserCascade.js';
import { sendAccountDeletionEmail } from '../../../utils/notifications/users/newUserNotifications.js';

// Helper function to generate JWT
const generateToken = (id, role, email) => {
    return jwt.sign({ id, role, email }, process.env.JWT_SECRET, {
        expiresIn: '30d',
    });
};

// @desc    Admin login
// @route   POST /api/admin/login
// @access  Public
export const adminLogin = asyncHandler(async (req, res) => {
    console.log("Received Login Request:", req.body);
    const { email, password } = req.body;

    const user = await User.findOne({ email });

    if (user && user.role === 'admin' && (await bcrypt.compare(password, user.password))) {
        const token = generateToken(user._id, user.role, user.email);

        res.cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        });

        res.status(200).json({
            success: true,
            message: 'Admin login successful',
            user: {
                _id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
            },
        });
    } else {
        res.status(401).json({ success: false, message: 'Invalid credentials or not an admin' });
    }
});

// @desc    Logout admin
// @route   POST /api/admin/logout
// @access  Private
export const adminLogout = asyncHandler(async (req, res) => {
    res.cookie('token', '', {
        httpOnly: true,
        expires: new Date(0),
    });

    res.status(200).json({ success: true, message: 'Admin logged out successfully' });
});

// @desc    Create a new user with different roles
// @route   POST /api/admin/users
// @access  Private (Admin only)
export const createUser = asyncHandler(async (req, res) => {
    console.log("🔹 Received User Creation Request:", req.body);
    const {
      name,
      email,
      password,
      confirmPassword,
      role,
      suburb,
      mobile,
      marketingOptIn = false,
    } = req.body;
  
    // 🔸 Basic field checks
    if (!name || !email || !password || !confirmPassword || !role || !suburb) {
      return res.status(400).json({ message: 'All fields including suburb are required' });
    }
  
    // 🔸 Validate password confirmation
    if (password !== confirmPassword) {
      return res.status(400).json({ message: 'Passwords do not match' });
    }
  
    // 🔸 Suburb validation
    const { name: suburbName, state, postalCode, location } = suburb;
  
    if (
      !suburbName ||
      !state ||
      !postalCode ||
      !location ||
      !Array.isArray(location.coordinates) ||
      location.coordinates.length !== 2
    ) {
      return res.status(400).json({ message: 'Valid suburb details are required' });
    }
  
    // 🔸 Optional: validate Australian mobile number if provided
    if (mobile && !/^04\d{8}$/.test(mobile)) {
      return res.status(400).json({ message: 'Mobile must be a valid Australian number (e.g. 04XXXXXXXX)' });
    }
  
    // 🔸 Check for duplicate user
    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ message: 'User already exists' });
    }
  
    // 🔸 Hash the password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
  
    // 🔸 Create user
    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      role,
      suburb: {
        name: suburbName,
        state,
        postalCode,
        location,
      },
      mobile,
      marketingOptIn,
      isAccountVerified: true,
      acceptedTermsAt: new Date(),
      acceptedTermsVersion: CURRENT_TERMS_VERSION || '1.0',
    });
  
    if (user) {
      res.status(201).json({
        success: true,
        message: 'User created successfully',
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          suburb: user.suburb,
          isAccountVerified: user.isAccountVerified,
        },
      });
    } else {
      res.status(500).json({ message: 'Failed to create user' });
    }
  });
  

// @desc    Get all users (with pagination)
// @route   GET /api/admin/users
// @access  Private (Admin only)
export const getUsers = asyncHandler(async (req, res) => {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const users = await User.find({})
        .select('-password')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);
    const totalUsers = await User.countDocuments();

    res.status(200).json({
        success: true,
        users,
        meta: {
            currentPage: page,
            totalPages: Math.ceil(totalUsers / limit),
            totalItems: totalUsers,
            itemsPerPage: limit,
        },
    });
});

// @desc    Get user by ID
// @route   GET /api/admin/users/:id
// @access  Private (Admin only)
export const getUserById = asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id).select('-password');

    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({
        success: true,
        user,
    });
});




// @desc    Update user by ID
// @route   PUT /api/admin/users/:id
// @access  Private (Admin only)
export const updateUser = asyncHandler(async (req, res) => {
    const {
      name,
      email,
      password,
      role,
      isAccountVerified,
      suburb,
      mobile,
      marketingOptIn,
    } = req.body;
  
    const user = await User.findById(req.params.id);
  
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
  
    // 🔸 Update basic fields only if provided
    if (name) user.name = name;
    if (email) user.email = email;
    if (role) user.role = role;
    if (isAccountVerified !== undefined) user.isAccountVerified = isAccountVerified;
  
    // 🔸 Update suburb (must have full object)
    if (suburb) {
      const { name: suburbName, state, postalCode, location } = suburb;
      if (
        !suburbName ||
        !state ||
        !postalCode ||
        !location ||
        !Array.isArray(location.coordinates) ||
        location.coordinates.length !== 2
      ) {
        return res.status(400).json({ message: 'Invalid suburb details' });
      }
  
      user.suburb = {
        name: suburbName,
        state,
        postalCode,
        location,
      };
    }
  
    // 🔸 Update mobile if valid
    if (mobile) {
      if (!/^04\d{8}$/.test(mobile)) {
        return res.status(400).json({ message: 'Invalid Australian mobile number (04XXXXXXXX)' });
      }
      user.mobile = mobile;
    }
  
    // 🔸 Update marketing opt-in
    if (marketingOptIn !== undefined) {
      user.marketingOptIn = marketingOptIn;
    }
  
    // 🔸 Update password if provided
    if (password) {
      const salt = await bcrypt.genSalt(10);
      user.password = await bcrypt.hash(password, salt);
    }
  
    const updatedUser = await user.save();
  
    res.status(200).json({
      success: true,
      message: 'User updated successfully',
      user: {
        _id: updatedUser._id,
        name: updatedUser.name,
        email: updatedUser.email,
        role: updatedUser.role,
        suburb: updatedUser.suburb,
        mobile: updatedUser.mobile,
        marketingOptIn: updatedUser.marketingOptIn,
        isAccountVerified: updatedUser.isAccountVerified,
      },
    });
  });
  


// @desc    Delete user by ID
// @route   DELETE /api/admin/users/:id
// @access  Private (Admin only)
export const deleteUser = asyncHandler(async (req, res) => {
    const userId = req.params.id;
    console.log('Admin deleteUser for user ID:', userId);
    
    const user = await User.findById(userId);

    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }

    // ✅ 1. Delete Conversations FIRST (to avoid broken refs)
    await deleteUserCascade.deleteConversationsByUser(userId);

    // ✅ 2. Then delete Adverts
    await deleteUserCascade.deleteAdvertsByUser(userId);

    // ✅ 3. Then delete Events
    await deleteUserCascade.deleteEventsByUser(userId);

    // ✅ 4. Then delete Threads
    await deleteUserCascade.deleteThreadsByUser(userId);

    // ✅ 5. Send account deletion email (before deleting user to have access to user data)
    try {
        await sendAccountDeletionEmail(user, true); // true = deletedByAdmin
        console.log('✅ Account deletion email sent by admin');
    } catch (error) {
        console.error('❌ Failed to send account deletion email:', error.message);
        // Continue with deletion even if email fails
    }

    // ✅ 6. Finally delete the User itself
    await user.deleteOne();

    res.status(200).json({ success: true, message: 'User and all associated data deleted successfully' });
});

// @desc    Validate admin token and return admin info
// @route   GET /api/admin/validate
// @access  Private (Admin only)
export const validateAdmin = asyncHandler(async (req, res) => {
    // req.user is set by authAdminMiddleware
    const admin = await User.findById(req.user.id).select('-password');
    
    if (!admin || admin.role !== 'admin') {
        return res.status(401).json({ success: false, message: 'Not authorized as admin' });
    }

    res.status(200).json({
        success: true,
        user: {
            _id: admin._id,
            name: admin.name,
            email: admin.email,
            role: admin.role,
        }
    });
});
