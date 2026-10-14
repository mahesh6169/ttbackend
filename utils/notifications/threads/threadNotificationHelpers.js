import User from '../../../models/userModel.js';

// 🔍 Find eligible recipients (excluding sender + muted threads)
export const determineThreadRecipients = async (thread, senderId) => {
  const allParticipants = thread.participants.map((id) => id.toString());
  const recipients = await User.find({
    _id: { $in: allParticipants, $ne: senderId },
    mutedThreads: { $ne: thread._id },
  }).select('email name threadNotifiedAt threadNotifyAtByThread');

  return recipients;
};



// ⏱️ Cooldown check (updated to use seconds instead of minutes)
// Use 10 seconds for development, 1800 seconds (30 minutes) for production
const DEFAULT_COOLDOWN_SECONDS = process.env.NODE_ENV === 'development' ? 10 : 1800;

export const shouldSendThreadNotification = (user, threadId, cooldownSeconds = DEFAULT_COOLDOWN_SECONDS) => {
  // Convert threadId to string for consistent Map key comparison
  const threadIdStr = threadId.toString();
  
  // Check per-thread cooldown first
  if (user.threadNotifyAtByThread && user.threadNotifyAtByThread.has(threadIdStr)) {
    const lastNotifiedForThread = user.threadNotifyAtByThread.get(threadIdStr);
    const now = Date.now();
    const lastNotified = new Date(lastNotifiedForThread).getTime();
    const diffSeconds = (now - lastNotified) / 1000;
    return diffSeconds >= cooldownSeconds;
  }
  
  // If no per-thread record exists, it's the first notification for this thread
  return true;
};



