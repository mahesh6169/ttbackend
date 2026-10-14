import { sendEmail } from '../sendEmail.js';

const websiteUrl = process.env.WEBSITE_URL || 'https://desify.com.au';
const platformName = process.env.NOTIFICATION_PLATFORM_NAME || 'the website';
const platformTeam = process.env.NOTIFICATION_PLATFORM_TEAM || 'Admin Team';

export const sendAdvertReminder14 = async (advert) => {
  const expiryDate = new Date(advert.expiresAt);
  const formattedDate = expiryDate.toLocaleDateString('en-AU', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
      <p>Hi,</p>
      <p>Your advert titled <strong>"${advert.title}"</strong> will expire on</p>
      <p>Expiry date: ${formattedDate}</p>
      <p>To keep it visible on ${platformName}, please renew it from your dashboard at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a>.</p>
      <p>Thank you,<br/>
      — ${platformTeam}</p>
    </div>
  `;

  try {
    await sendEmail({
      to: advert.postedBy.email,
      subject: `Reminder: Your advert "${advert.title}" is about to expire`,
      html
    });
    console.log(`✅ 14-day reminder sent to: ${advert.postedBy.email}`);
  } catch (error) {
    console.error(`❌ Failed to send 14-day reminder: ${error.message}`);
  }
};

export const sendAdvertReminder7 = async (advert) => {
  const expiryDate = new Date(advert.expiresAt);
  const formattedDate = expiryDate.toLocaleDateString('en-AU', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
      <p>Hi,</p>
      <p>Your advert titled <strong>"${advert.title}"</strong> will expire on </p>
      <p>Expiry date: ${formattedDate}</p>
      <p>To keep it visible on ${platformName}, please renew it now from your dashboard at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a>.</p>
      <p>Thank you,<br/>
      — ${platformTeam}</p>
    </div>
  `;

  try {
    await sendEmail({
      to: advert.postedBy.email,
      subject: `Reminder: Your advert "${advert.title}" expires soon`,
      html
    });
    console.log(`✅ 7-day reminder sent to: ${advert.postedBy.email}`);
  } catch (error) {
    console.error(`❌ Failed to send 7-day reminder: ${error.message}`);
  }
};
