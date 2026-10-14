import { sendEmail } from '../sendEmail.js';

const websiteUrl = process.env.WEBSITE_URL;
const platformName = process.env.NOTIFICATION_PLATFORM_NAME || 'the website';
const platformTeam = process.env.NOTIFICATION_PLATFORM_TEAM || 'Admin Team';


// to test it for less 30min 
//const NOTIFY_COOLDOWN_MINUTES = 0.5; at the controller  ttbackendflyio/controllers/shared/messageController.js
export const sendNewMessageNotificationEmail = async (user, resourceType, resourceTitle, messageContent, eventDate = null) => {
  // Format date if it's an event
  let titleWithDate = resourceTitle;
  if (resourceType === 'event' && eventDate) {
    const dateObj = new Date(eventDate);
    const formattedDate = dateObj.toLocaleDateString('en-AU', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
    titleWithDate = `${resourceTitle} - ${formattedDate}`;
  }

  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
      <p>Hi,</p>
      <p>You have a new message regarding your ${resourceType} <strong>"${titleWithDate}"</strong>:</p>
      <p style="background-color: #f5f5f5; padding: 12px; border-radius: 5px; margin: 15px 0;">
        "${messageContent}"
      </p>
      <p>View and reply at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a>.</p>
      <p>Thank you,<br/>
      — ${platformTeam}</p>
    </div>
  `;

  try {
    await sendEmail({
      to: user.email,
      from: { email: 'noreply@desify.com.au', name: platformName },
      subject: `New message on "${titleWithDate}"`,
      html
    });
    console.log(`✅ Chat notification email sent to ${user.email}`);
  } catch (error) {
    console.error('❌ Failed to send chat notification email:', error.message);
    throw error;
  }
};

export const sendThreadNotificationEmail = async (user, threadTitle, threadId) => {
  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
      <p>Hi,</p>
      <p>Someone commented on the thread <strong>"${threadTitle}"</strong>.</p>
      <p>View the discussion at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a>.</p>
      <p>Thank you,<br/>
      — ${platformTeam}</p>
    </div>
  `;

  try {
    await sendEmail({
      to: user.email,
      from: { email: 'noreply@desify.com.au', name: platformName },
      subject: `New comment on thread: "${threadTitle}"`,
      html
    });
    console.log(`✅ Thread notification email sent to ${user.email}`);
  } catch (error) {
    console.error('❌ Failed to send thread notification email:', error.message);
    throw error;
  }
};