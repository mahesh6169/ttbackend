import asyncHandler from 'express-async-handler';
import transporter from '../../config/nodemailer.js';
import bcrypt from 'bcryptjs';
import User from '../../models/userModel.js';
import Advert from '../../models/advertModel.js';
import jwt from 'jsonwebtoken';
import Event from '../../models/eventModel.js';
import { CURRENT_TERMS_VERSION } from '../../constants/terms.js';
import { sendWelcomeEmail, sendVerifyOtpEmail, sendResetOtpEmail, sendAccountDeletionEmail } from '../../utils/notifications/users/newUserNotifications.js';
import { verifyRecaptcha } from '../../utils/verifyRecaptcha.js';
import * as deleteUserCascade from '../../utils/helpers/users/deleteUserCascade.js';




// @desc    Register a new user.
// @route   POST /api/users/register
// @access  Public
export const registerUser = asyncHandler(async (req, res) => {
    const {
        name,
        email,
        password,
        confirmPassword,
        mobile,
        suburb,
        marketingOptIn = false,
        captchaToken,  // 👈 Grab token from frontend
    } = req.body;

    console.log('registerUser Request body:', req.body);

    // ✅ Verify reCAPTCHA first
    if (!captchaToken) {
        console.error('🚩 Missing reCAPTCHA token in request body:', req.body);
        return res.status(400).json({ message: 'reCAPTCHA token missing' });
    }

    try {
        const recaptchaResult = await verifyRecaptcha(captchaToken);
        console.log('✅ reCAPTCHA verified:', recaptchaResult);
    } catch (error) {
        return res.status(400).json({ message: 'reCAPTCHA verification failed' });
    }

    // ✅ Proceed with your existing logic (no changes needed below here)
    if (!name || !email || !password || !confirmPassword) {
        return res.status(400).json({ message: 'Name, Email, and Password are required' });
    }

    if (password !== confirmPassword) {
        return res.status(400).json({ message: 'Passwords do not match' });
    }

    if (mobile && !/^04\d{8}$/.test(mobile)) {
        return res.status(400).json({ message: 'Mobile must start with 04 and be 10 digits' });
      }

    const { name: suburbName, state, postalCode, location } = suburb || {};
    // Postal code is now optional - removed from validation
    if (!suburbName || !state || !Array.isArray(location?.coordinates) || location.coordinates.length !== 2) {
        return res.status(400).json({ message: 'Invalid or missing suburb data' });
    }

    const userExist = await User.findOne({ email });
    if (userExist) {
        if (userExist.role === 'guest') {
            return await upgradeGuestToUser(userExist, { name, password, mobile, suburb, marketingOptIn }, res);
        } else {
            return res.status(400).json({ message: 'User already exists' });
        }
    }

    return await createNewUser(name, email, password, res, {
        mobile,
        suburb,
        marketingOptIn,
        acceptedTermsAt: new Date(),
        acceptedTermsVersion: CURRENT_TERMS_VERSION
    });
});


// Helper function to upgrade a guest user to a regular user. The guest record was created from
// email alone (no suburb), so we must populate the full profile from the register form here -
// otherwise saving with role 'user' fails the suburb-required validation. The record keeps its
// _id, so all the guest's past registrations/tickets stay attached.
const upgradeGuestToUser = async (guestUser, { name, password, mobile, suburb, marketingOptIn }, res) => {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    guestUser.name = name; // Update name
    guestUser.password = hashedPassword; // Set new hashed password
    guestUser.role = 'user'; // Upgrade to user role
    guestUser.suburb = suburb; // Required for a full user; comes from the register form
    if (mobile) guestUser.mobile = mobile;
    guestUser.marketingOptIn = marketingOptIn ?? false;
    guestUser.acceptedTermsAt = new Date();
    guestUser.acceptedTermsVersion = CURRENT_TERMS_VERSION;

    const updatedUser = await guestUser.save();

    if (updatedUser) {
        const token = generateToken(updatedUser._id); // Generate a JWT token
        setAuthCookie(res, token);

        console.log('Cookie set during guest upgrade:', res.getHeader('Set-Cookie'));

        await sendWelcomeEmail(updatedUser);

        return res.status(200).json({
            _id: updatedUser._id,
            name: updatedUser.name,
            email: updatedUser.email,
            isAccountVerified: updatedUser.isAccountVerified,
            message: 'Guest account upgraded to user account',
        });
    } else {
        return res.status(500).json({ message: 'Failed to upgrade guest account' });
    }
};

// Helper function to create a new user
export const createNewUser = async (name, email, password, res, extra = {}) => {
    console.log('Creating new user:', name, email);
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await User.create({
        name,
        email,
        password: hashedPassword,
        role: 'user',
        ...extra,
    });

    if (user) {
        const token = generateToken(user._id);
        setAuthCookie(res, token);
        console.log('Cookie set during registration:', res.getHeader('Set-Cookie'));

        await sendWelcomeEmail(user);

        return res.status(201).json({
            _id: user._id,
            name: user.name,
            email: user.email,
            isAccountVerified: user.isAccountVerified,
        });
    } else {
        return res.status(500).json({ message: 'Failed to register user' });
    }
};



// Helper function to set the authentication cookie
export const setAuthCookie = (res, token, maxAge = 30 * 24 * 60 * 60 * 1000) => {
    const cookieOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'lax' : 'strict',
        path: '/',
    };
    // maxAge null => a browser-session cookie (used for guests). A number => a persistent
    // cookie of that many ms (default 30 days for members, aligned with the JWT expiry).
    if (maxAge != null) {
        cookieOptions.maxAge = maxAge;
    }
    res.cookie('token', token, cookieOptions);
};
/*
// Helper function to send the welcome email
export const sendWelcomeEmail = async (user) => {
    const mailOptions = {
        from: process.env.SENDER_EMAIL,
        to: user.email,
        subject: 'Welcome To MarketPlace',
        text: `Hello ${user.name},\n\nWelcome to MarketPlace! Your account has been successfully created with email: ${user.email}.\n\nThank you for joining us.\n\nBest Regards,\nMarketPlace Team`,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log('Welcome email sent to:', user.email);
    } catch (error) {
        console.error('Error sending welcome email:', error.message);
    }
};
*/

// @desc    Login a new user
// @route   POST /api/users/login
// @access  Public
export const loginUser = asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    // Find the user by email
    const user = await User.findOne({ email });

    // Check if the user exists and the password is correct
    if (user && (await bcrypt.compare(password, user.password))) {
        const token = generateToken(user._id, user.role); // Generate a JWT token

        // Set the token in a cookie
        setAuthCookie(res, token);

        // Respond with user details
        res.status(200).json({
            success: true,
            message: 'Login successful',
            user: {
                _id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                isAccountVerified: user.isAccountVerified,
                suburb: user.suburb || null, // Include suburb data for state selection
            },
        });
    } else {
        res.status(401).json({
            success: false,
            message: 'Invalid credentials',
        });
    }
});

// @desc    Start (or resume) a guest session for event RSVP / checkout.
//          Creates a lightweight guest user from an email alone, or reuses an
//          existing guest record. Refuses emails that belong to a full account.
// @route   POST /api/users/guest
// @access  Public
export const continueAsGuest = asyncHandler(async (req, res) => {
    const { email, captchaToken } = req.body;

    // Bot defence: same reCAPTCHA check register/login use.
    if (!captchaToken) {
        return res.status(400).json({ message: 'reCAPTCHA token missing' });
    }
    try {
        await verifyRecaptcha(captchaToken);
    } catch (error) {
        return res.status(400).json({ message: 'reCAPTCHA verification failed' });
    }

    // Basic email presence + shape check.
    const normalisedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!normalisedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalisedEmail)) {
        return res.status(400).json({ message: 'A valid email is required' });
    }

    const existing = await User.findOne({ email: normalisedEmail });

    // Email already belongs to a full account: do not silently attach - send them to log in.
    if (existing && existing.role !== 'guest') {
        return res.status(409).json({
            code: 'ACCOUNT_EXISTS',
            message: 'This email has an account. Please log in.',
        });
    }

    // Reuse an existing guest record, or create a fresh one (email only).
    const guestUser = existing || await User.create({ email: normalisedEmail, role: 'guest' });

    // Session-scoped guest: a browser-session cookie (maxAge null) so the guest is a stranger
    // again on the next visit, with the 6-hour token as the real backstop (browser-close is
    // unreliable on mobile). See featureplans/events-guest-attendee.md.
    const GUEST_TOKEN_EXPIRY = '6h';
    const token = generateToken(guestUser._id, 'guest', GUEST_TOKEN_EXPIRY);
    setAuthCookie(res, token, null);

    return res.status(200).json({
        _id: guestUser._id,
        name: guestUser.name,
        email: guestUser.email,
        role: guestUser.role,
        isAccountVerified: guestUser.isAccountVerified,
    });
});

// @desc    Validate the token and return user details
// @route   GET /api/users/validate
// @access  Public
export const validateToken = asyncHandler(async (req, res) => {
    const token = req.cookies.token;

    if (!token) {
        return res.status(401).json({ message: 'usercontroller/validateToken - Authentication token not found' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id).select('-password');

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.status(200).json({
            isAuthenticated: true,
            user: { 
                _id: user._id, 
                name: user.name, 
                email: user.email, 
                role: user.role,  
                mutedThreads: user.mutedThreads || [],  
                isAccountVerified: user.isAccountVerified, 
                suburb: user.suburb || null,
                // ✅ Updated Stripe fields - only what's needed
                stripeAccountId: user.stripeAccountId || null,
                stripeAccountStatus: user.stripeAccountStatus || 'no_account',
                // 🏷️ Host-type flags (see HostTypeFlags.md) - drive the Organiser menu
                freeHost: user.freeHost || false,
                paidHost: user.paidHost || false,
                promoHost: user.promoHost || false,
            },
        });
    } catch (err) {
        console.error('Token validation error:', err);
        res.status(401).json({ message: 'Invalid or expired token' });
    }
});

// @desc    Logout a user
// @route   POST /api/users/logout
// @access  Private
export const logoutUser = asyncHandler(async (req, res) => {
    res.cookie('token', '', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'lax' : 'strict',
        maxAge: 0,
        path: '/',
    });
    res.status(200).json({ message: 'Logged out successfully' });
});

// @desc    Get user profile and adverts
// @route   GET /api/users/fetchuserprofile
// @access  Private
export const fetchUserProfile = asyncHandler(async (req, res) => {
    try {
        const userId = req.user.id;

        const user = await User.findById(userId).select('-password');
        if (!user) {
            console.error(`User not found for ID: ${userId}`);
            return res.status(404).json({ message: 'User not found' });
        }

        const adverts = await Advert.find({ postedBy: userId });

        return res.status(200).json({
            user: {
                _id: user._id,
                name: user.name,
                email: user.email,
                role: user.role, 
                isAccountVerified: user.isAccountVerified,
                acceptedTermsVersion: user.acceptedTermsVersion || null,  // ✅ add this
                acceptedTermsAt: user.acceptedTermsAt || null,     // ✅ add this
            },
            adverts: adverts.length > 0 ? adverts : [],
        });
    } catch (error) {
        console.error('Error in getUserProfile:', error.message);
        return res.status(500).json({ message: 'Internal Server Error' });
    }
});

// @desc    Send Verification OTP to email
// @route   POST /api/users/sendVerifyOtp
// @access  Private
export const sendVerifyOtp = asyncHandler(async (req, res) => {
    console.log('🔹 sendVerifyOtp function called'); // Debug log

    try {
        const userId = req.user.id;
        console.log('🔹 User ID:', userId); // Debug log

        const user = await User.findById(userId).select('-password');
        if (!user) {
            console.log('🔸 User not found'); // Debug log
            return res.status(404).json({ message: 'User not found' });
        }

        if (user.isAccountVerified) {
            console.log('🔸 User already verified'); // Debug log
            return res.status(400).json({ message: 'Account already verified' });
        }

        const otp = String(Math.floor(100000 + Math.random() * 900000)); // Ensure 6-digit OTP
        console.log('🔹 Generated OTP:', otp); // Debug log

        user.verifyOtp = otp;
        user.verifyOtpExpireAt = Date.now() + 15 * 60 * 1000; // 15 minutes
        await user.save();

        console.log('🔹 OTP saved to user profile'); // Debug log

        await sendVerifyOtpEmail({
            email: user.email,
            name: user.name,
            otp,
          });

        /*const mailOptions = {
            from: process.env.SENDER_EMAIL,
            to: user.email,
            subject: 'Account Verification OTP',
            text: `Hello ${user.name},\n\nYour OTP for account verification is: ${otp}.\n\nThis OTP is valid for 15 minutes.\n\nBest Regards,\nMarketPlace Team`,
        };

        console.log('🔹 Sending OTP email...'); // Debug log

        await transporter.sendMail(mailOptions);
        console.log('✅ OTP email sent successfully to:', user.email); // Debug log */

        res.json({ success: true, message: 'OTP sent successfully' });
    } catch (error) {
        console.error('❌ Error in sendVerifyOtp:', error.message); // Debug log
        return res.status(500).json({ success: false, message: 'An unexpected error occurred', error: error.message });
    }
});


// @desc    Verify Email AKA verify account
// @route   POST /api/users/sendVerifyOtp
// @access  Private
export const verifyEmail = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { otp } = req.body;

    console.log('verifyEmail Request body:', req.body);
    console.log('verifyEmail User ID:', userId);

    if (!userId || !otp) {
        return res.status(400).json({ message: 'Missing Details' });
    }
    try {
        const user = await User.findById(userId).select('-password');

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (user.verifyOtp === '' || user.verifyOtp !== otp) {
            return res.status(400).json({ message: 'Invalid OTP' });
        }

        if (user.verifyOtpExpireAt < Date.now()) {
            return res.status(400).json({ message: 'OTP expired' });
        }

        user.isAccountVerified = true;
        user.verifyOtp = '';
        user.verifyOtpExpireAt = 0;

        await user.save();

        return res.status(200).json({ message: 'Account verified successfully' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'An unexpected error occurred', error: error.message });
    }
});

// @desc    Send Password reset OTP Email
// @route   POST /api/users/sendResetOtp
// @access  Private
export const sendResetOtp = asyncHandler(async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ message: 'Email is required' });
    }

    try {
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const otp = String(Math.floor(1000000 + Math.random() * 9000));

        user.resetOtp = otp;
        user.resetOtpExpireAt = Date.now() + 15 * 60 * 1000; // 15 minutes

        await user.save();

        await sendResetOtpEmail({
            email: user.email,
            name: user.name,
            otp,
          });
      

       /* const mailOptions = {
            from: process.env.SENDER_EMAIL,
            to: user.email,
            subject: 'Password Reset OTP',
            text: `Hello ${user.name},\n\nYour OTP for password reset is: ${otp}.\n\nThis OTP is valid for 15 minutes.\n\nBest Regards,\nMarketPlace Team`,
        };

        await transporter.sendMail(mailOptions); */

        res.json({ success: true, message: 'OTP sent successfully' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'An unexpected error occurred', error: error.message });
    }
});

// @desc    Verify a password-reset OTP without resetting — lets the UI confirm the code on step 2
// @route   POST /api/users/verifyResetOtp
// @access  Public
export const verifyResetOtp = asyncHandler(async (req, res) => {
    const { email, otp } = req.body;

    if (!email || !otp) {
        return res.status(400).json({ message: 'Email and OTP are required' });
    }

    try {
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Validate only — do NOT clear the OTP; the final resetPassword step still needs it
        if (!user.resetOtp || user.resetOtp !== otp) {
            return res.status(400).json({ message: 'Invalid OTP' });
        }

        if (user.resetOtpExpireAt < Date.now()) {
            return res.status(400).json({ message: 'OTP expired' });
        }

        return res.status(200).json({ success: true, message: 'OTP verified' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'An unexpected error occurred', error: error.message });
    }
});

// @desc    Reset Password
// @route   POST /api/users/resetPassword
// @access  Public
export const resetPassword = asyncHandler(async (req, res) => {
    const { email, otp, newPassword, confirmPassword } = req.body;

    // ✅ Validate required fields
    if (!email || !otp || !newPassword || !confirmPassword) {
        return res.status(400).json({ message: 'Email, OTP, and both password fields are required' });
    }

    // ✅ Check if passwords match
    if (newPassword !== confirmPassword) {
        return res.status(400).json({ message: 'Passwords do not match' });
    }

    try {
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // ✅ Check OTP
        if (!user.resetOtp || user.resetOtp !== otp) {
            return res.status(400).json({ message: 'Invalid OTP' });
        }

        // ✅ Check if OTP has expired
        if (user.resetOtpExpireAt < Date.now()) {
            return res.status(400).json({ message: 'OTP expired' });
        }

        // ✅ Hash new password and update user
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        user.password = hashedPassword;
        user.resetOtp = '';
        user.resetOtpExpireAt = 0;

        await user.save();

        return res.status(200).json({ message: 'Password reset successfully' });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'An unexpected error occurred',
            error: error.message,
        });
    }
});


// @desc    Add advert to wishlist
export const addToWishlist = asyncHandler(async (req, res) => {
    const { advertId } = req.body;
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    user.wishlist = user.wishlist || [];

    const alreadyExists = user.wishlist.some(id => id.toString() === advertId);
    if (!alreadyExists) {
        user.wishlist.push(advertId);
        await user.save();
    }

    res.status(200).json({ wishlist: user.wishlist.map(id => id.toString()) });
});


export const removeFromWishlist = asyncHandler(async (req, res) => {
    const { advertId } = req.body;
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    user.wishlist = user.wishlist.filter(id => id.toString() !== advertId);
    await user.save();

    res.status(200).json({ wishlist: user.wishlist.map(id => id.toString()) });
});

export const getWishlist = asyncHandler(async (req, res) => {
    const userId = req.user.id;
  
    const user = await User.findById(userId).populate({
      path: 'wishlist',
      // Remove `select` to include all fields
      populate: {
        path: 'postedBy',
        select: 'name', // Optional: include poster's name
      },
    });
  
    if (!user) return res.status(404).json({ message: 'User not found' });
  
    // Send full advert objects
    res.status(200).json({ wishlist: user.wishlist });
  });
  


// @desc    Add event to wishlist
export const addToEventWishlist = asyncHandler(async (req, res) => {
    const { eventId } = req.body;
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.eventWishlist = user.eventWishlist || [];

    const alreadyExists = user.eventWishlist.some(id => id.toString() === eventId);
    if (!alreadyExists) {
        user.eventWishlist.push(eventId);
        await user.save();
    }

    res.status(200).json({ eventWishlist: user.eventWishlist.map(id => id.toString()) });
});


// @desc    Remove event from wishlist
export const removeFromEventWishlist = asyncHandler(async (req, res) => {
    const { eventId } = req.body;
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.eventWishlist = user.eventWishlist.filter(id => id.toString() !== eventId);
    await user.save();

    res.status(200).json({ eventWishlist: user.eventWishlist.map(id => id.toString()) });
});


// @desc    Get full event wishlist.
export const getEventWishlist = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const user = await User.findById(userId).populate('eventWishlist');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.status(200).json({ wishlist: user.eventWishlist });
});
  


// API CONTROLLER TO FETCH FULL ACCOUNT DETAILS
export const getAccountDetails = asyncHandler(async (req, res) => {
    console.log('GET /api/account - getAccountDetails API was hit');
    try {
        const userId = req.user.id;
        const user = await User.findById(userId).select('-password');

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const {
            name,
            email,
            mobile = '',
            suburb = {},
            marketingOptIn = false,
        } = user;

        res.status(200).json({
            user: {
                _id: user._id,
                name,
                email,
                mobile,
                marketingOptIn,
                suburb: {
                    name: suburb?.name || '',
                    state: suburb?.state || '',
                    postalCode: suburb?.postalCode || '',
                    location: suburb?.location || { type: 'Point', coordinates: [0, 0] },
                },
            },
        });
    } catch (error) {
        console.error('Error in getAccountDetails:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});


// API CONTROLLER TO UPDATE ACCOUNT DETAILS
export const updateAccountDetails = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const {
        name,
        address,
        mobile,
        suburb,
        marketingOptIn
    } = req.body;

    console.log('Received update data:', req.body);

    try {
        const user = await User.findById(userId);

        if (!user) return res.status(404).json({ message: 'User not found' });

        if (name !== undefined) user.name = name;
        if (address !== undefined) user.address = address;
        if (mobile !== undefined) user.mobile = mobile;
        if (suburb !== undefined) user.suburb = suburb;
        if (marketingOptIn !== undefined) {
            user.marketingOptIn = marketingOptIn === true || marketingOptIn === 'true';
        }

        await user.save();
        res.status(200).json({ message: 'Account details updated successfully' });
    } catch (error) {
        console.error('Error in updateAccountDetails:', error);
        res.status(500).json({ message: 'Failed to update user details' });
    }
});


// DELETE /api/users/delete-account
export const deleteUser = asyncHandler(async (req, res) => {
    const userId = req.user.id; // ✅ Secure: fetched from the auth token
    console.log('deleteUser Request body:', req.body);
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
     await sendAccountDeletionEmail(user);
     console.log('✅ Account deletion email sent');
 } catch (error) {
     console.error('❌ Failed to send account deletion email:', error.message);
     // Continue with deletion even if email fails
 }

 // ✅ 6. Finally delete the User itself
 await user.deleteOne();

    res.status(200).json({ success: true, message: 'User deleted successfully' });
});

// @desc    Accept updated terms and conditions
export const acceptUpdatedTerms = asyncHandler(async (req, res) => {
    const user = req.user;
    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }

    user.acceptedTermsVersion = CURRENT_TERMS_VERSION;
    user.acceptedTermsAt = new Date();
    await user.save();

    res.status(200).json({
        message: 'Terms accepted',
        acceptedTermsVersion: CURRENT_TERMS_VERSION,
        acceptedTermsAt: user.acceptedTermsAt,
    });
});


// Mute Thread Notifications
// This endpoint allows a user to mute notifications for a specific thread
export const muteThreadNotification = asyncHandler(async (req, res) => {
    const { threadId } = req.params;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
  
    if (!user.mutedThreads.includes(threadId)) {
      user.mutedThreads.push(threadId);
      await user.save();
    }
    res.status(200).json({ success: true, message: 'Thread notifications muted' });
  });
  
  // Unmute Thread Notifications
  // This endpoint allows a user to unmute notifications for a specific thread
  export const unmuteThreadNotification = asyncHandler(async (req, res) => {
    const { threadId } = req.params;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
  
    user.mutedThreads = user.mutedThreads.filter(id => id.toString() !== threadId);
    await user.save();
    res.status(200).json({ success: true, message: 'Thread notifications unmuted' });
  });
  


// Generate token
const generateToken = (id, role, expiresIn) => {
    // Members stay signed in for 30 days (industry standard for consumer ticketing), matching the
    // auth cookie's maxAge below so the two lifetimes agree. A caller can override the lifetime
    // (guest sessions pass a short expiry).
    const tokenExpiry = expiresIn || '30d';

    return jwt.sign({ id, role }, process.env.JWT_SECRET, {
        expiresIn: tokenExpiry,
    });

};