import { sendEmail } from '../sendEmail.js';

const websiteUrl = process.env.WEBSITE_URL;
const platformName = process.env.NOTIFICATION_PLATFORM_NAME || 'the website';
const platformTeam = process.env.NOTIFICATION_PLATFORM_TEAM || 'Admin Team';

export const addDealNotification = async ({ type, deal }) => {
  if (type !== 'created' || !deal?.postedBy?.email) return;

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
  <p>Hi,</p>
  <p>Your deal titled <strong>"${deal.dealTitle}"</strong> has been successfully posted on ${platformName}.</p>
  <p>Store: ${deal.partnerstoreId?.businessName || 'Your store'}</p>
  <p>Manage your deals from the User Profile at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a></p>
  <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Edit/Delete Deal</strong> : Profile > Manage > Daily Deals</p>
  <p>Thank you,<br/>
  — ${platformTeam}</p>
</div>
  `;

  try {
    await sendEmail({
      to: deal.postedBy.email,
      subject: `Deal "${deal.dealTitle}" is live`,
      html: htmlContent,
    });

    console.log(`✅ Deal creation confirmation sent to ${deal.postedBy.email}`);
  } catch (error) {
    console.error(`❌ Failed to send deal creation confirmation: ${error.message}`);
  }
};

export const updateDealNotification = async ({ type, deal }) => {
  if (type !== 'updated' || !deal?.postedBy?.email) return;

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
  <p>Hi,</p>
  <p>Your deal titled <strong>"${deal.dealTitle}"</strong> has been successfully updated.</p>
  <p>Manage your deals from the User Profile at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a></p>
  <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Edit/Delete Deal</strong> : Profile > Manage > Daily Deals</p>
  <p>Thank you,<br/>
  — ${platformTeam}</p>
</div>
  `;

  try {
    await sendEmail({
      to: deal.postedBy.email,
      subject: `Deal "${deal.dealTitle}" is updated`,
      html: htmlContent,
    });

    console.log(`✅ Deal update notification sent to ${deal.postedBy.email}`);
  } catch (error) {
    console.error(`❌ Failed to send deal update notification: ${error.message}`);
  }
};

export const deleteDealNotification = async ({ type, deal }) => {
  if ((type !== 'deleted' && type !== 'deletedByAdmin') || !deal?.postedBy?.email) return;

  let htmlContent;

  if (type === 'deletedByAdmin') {
    htmlContent = `
      <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
    <p>Hi,</p>
    <p>Your deal titled <strong>"${deal.dealTitle}"</strong> has been removed by the ${platformName} Admin.</p>
    <p>If you have any questions, please contact us at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a>.</p>
    <p>Regards,<br/>
    — ${platformTeam}</p>
  </div>
    `;
  } else {
    htmlContent = `
      <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
    <p>Hi,</p>
    <p>Your deal titled <strong>"${deal.dealTitle}"</strong> has been successfully removed.</p>
    <p>Thank you,<br/>
    — ${platformTeam}</p>
  </div>
    `;
  }

  try {
    await sendEmail({
      to: deal.postedBy.email,
      subject: `Deal "${deal.dealTitle}" is removed`,
      html: htmlContent,
    });

    console.log(`✅ Deal deletion notification sent to ${deal.postedBy.email}`);
  } catch (error) {
    console.error(`❌ Failed to send deal deletion notification: ${error.message}`);
  }
};
