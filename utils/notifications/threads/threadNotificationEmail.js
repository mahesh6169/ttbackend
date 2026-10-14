import { sendEmail } from '../sendEmail.js';

const websiteUrl = process.env.WEBSITE_URL;
const platformName = process.env.NOTIFICATION_PLATFORM_NAME || 'the website';
const platformTeam = process.env.NOTIFICATION_PLATFORM_TEAM || 'Admin Team';

export const sendThreadNotificationEmail = async (user, threadTitle, threadId, messageContent = '') => {
  // Get first line of the message and truncate if needed
  let messagePreview = '';
  if (messageContent) {
    const firstLine = messageContent.split('\n')[0].trim();
    if (firstLine.length > 100) {
      messagePreview = firstLine.substring(0, 100) + '...';
    } else {
      messagePreview = firstLine;
    }
  }
  
  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
      <p>Hi,</p>
      <p>A new comment has been posted on the thread titled <strong>"${threadTitle}"</strong>.</p>
      ${messagePreview ? `<p style="padding: 10px; background-color: #f5f5f5; border-left: 3px solid #3b82f6; margin: 10px 0;"><em>"${messagePreview}"</em></p>` : ''}
      <p>View the discussion at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a>.</p>
      <p style="font-size: 12px; color: #800000;">To mute notifications for this thread, go to Dashboard > Manage Topics and click the 🔔 bell icon, or simply click the 🔔 bell icon directly on the topic page.</p>
      <p>Thank you,<br/>
      — ${platformTeam}</p>
    </div>
  `;

  try {
    await sendEmail({
      to: user.email,
      subject: `New comment on thread: "${threadTitle}"`,
      html
    });
    console.log(`✅ Thread notification email sent to ${user.email}`);
  } catch (error) {
    console.error('❌ Failed to send thread notification email:', error.message);
    throw error;
  }
};
