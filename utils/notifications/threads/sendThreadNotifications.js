import { sendEmail } from '../sendEmail.js';

const websiteUrl = process.env.WEBSITE_URL;
const platformName = process.env.NOTIFICATION_PLATFORM_NAME || 'the website';
const platformTeam = process.env.NOTIFICATION_PLATFORM_TEAM || 'Admin Team';

export const addThreadNotification = async ({ type, thread }) => {
  if (type !== 'created' || !thread?.owner?.email) return;

  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
      <p>Hi,</p>
      <p>Your topic titled <strong>"${thread.title}"</strong> has been successfully posted on ${platformName}.</p>
      <p>Manage your topics from the User Dashboard at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a>.</p>
      <p>Thank you,<br/>
      — ${platformTeam}</p>
    </div>
  `;

  try {
    await sendEmail({
      to: thread.owner.email,
      subject: `Topic "${thread.title}" is live`,
      html,
    });
    console.log(`✅ Thread creation email sent to ${thread.owner.email}`);
  } catch (err) {
    console.error(`❌ Failed to send thread creation email: ${err.message}`);
  }
};

export const updateThreadNotification = async ({ type, thread }) => {
  if (type !== 'updated' || !thread?.owner?.email) return;

  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
      <p>Hi,</p>
      <p>Your topic titled <strong>"${thread.title}"</strong> has been successfully updated.</p>
      <p>Manage your topics from the User Dashboard at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a>.</p>
      <p>Thank you,<br/>
      — ${platformTeam}</p>
    </div>
  `;

  try {
    await sendEmail({
      to: thread.owner.email,
      subject: `Topic "${thread.title}" is updated`,
      html,
    });
    console.log(`✅ Thread update email sent to ${thread.owner.email}`);
  } catch (err) {
    console.error(`❌ Failed to send thread update email: ${err.message}`);
  }
};

export const deleteThreadNotification = async ({ type, thread }) => {
  if (
    (type !== 'deleted' && type !== 'deletedByAdmin') ||
    !thread?.owner?.email
  )
    return;

  let html;

  if (type === 'deletedByAdmin') {
    html = `
      <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
        <p>Hi,</p>
        <p>Your topic titled <strong>"${thread.title}"</strong> has been removed by the ${platformName} Admin.</p>
        <p>Common reasons for thread deletion include:</p>
<ul>
  <li>The thread was reported as inappropriate.</li>
</ul>
        <p>If you have any questions, please contact us at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a>.</p>
        <p>Regards,<br/>
        — ${platformTeam}</p>
      </div>
    `;
  } else {
    html = `
      <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
        <p>Hi,</p>
        <p>Your topic titled <strong>"${thread.title}"</strong> has been successfully removed.</p>
        <p>Thank you,<br/>
        — ${platformTeam}</p>
      </div>
    `;
  }

  try {
    await sendEmail({
      to: thread.owner.email,
      subject: `Topic "${thread.title}" is removed`,
      html,
    });
    console.log(`✅ Thread deletion email sent to ${thread.owner.email}`);
  } catch (err) {
    console.error(`❌ Failed to send thread deletion email: ${err.message}`);
  }
};
