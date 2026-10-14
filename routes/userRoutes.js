import express from 'express';
import { 
    registerUser,
    continueAsGuest,
    loginUser,
    logoutUser,
    fetchUserProfile, 
    validateToken, 
    sendVerifyOtp, 
    verifyEmail, 
    sendResetOtp,
    verifyResetOtp,
    resetPassword,
    addToWishlist, 
    removeFromWishlist, 
    getWishlist,
    getAccountDetails,
    updateAccountDetails,
    deleteUser,
    getEventWishlist,
    addToEventWishlist,
    removeFromEventWishlist,
    acceptUpdatedTerms,
    muteThreadNotification,
    unmuteThreadNotification,    

} from '../controllers/users/userController.js';

import authMiddleware from '../middlewares/authMiddleware.js';

const router = express.Router();

// Auth & Registration
router.post('/register', registerUser);
router.post('/guest', continueAsGuest);
router.post('/login', loginUser);
router.get('/validate', validateToken);
router.post('/logout', authMiddleware, logoutUser);


// Email Verification & Password Reset
router.post('/sendVerifyOtp', authMiddleware, sendVerifyOtp);
router.post('/verifyEmail', authMiddleware, verifyEmail);
router.post('/sendResetOtp', sendResetOtp);
router.post('/verifyResetOtp', verifyResetOtp);
router.post('/resetPassword', resetPassword);

// Profile & Account
router.get('/fetchUserProfile', authMiddleware, fetchUserProfile);

// ✅ NEW: Account details view & update
router.get('/account/details', authMiddleware, getAccountDetails);
router.put('/account/details', authMiddleware, updateAccountDetails);
router.delete('/account/delete', authMiddleware, deleteUser);

// Wishlist
router.post('/wishlist/add', authMiddleware, addToWishlist);
router.delete('/wishlist/remove', authMiddleware, removeFromWishlist);
router.get('/wishlist', authMiddleware, getWishlist);

// 🔥 Event Wishlist (NEW)
router.post('/eventwishlist/add', authMiddleware, addToEventWishlist);
router.delete('/eventwishlist/remove', authMiddleware, removeFromEventWishlist);
router.get('/eventwishlist', authMiddleware, getEventWishlist);

// Accept Updated Terms
router.patch('/accept-terms', authMiddleware, acceptUpdatedTerms);

//Mute and Unmute Thread Notifications
router.patch('/mute/:threadId', authMiddleware, muteThreadNotification);
router.patch('/unmute/:threadId', authMiddleware, unmuteThreadNotification);

export default router;
