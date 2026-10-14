import { sendEmail } from '../sendEmail.js';

const websiteUrl = process.env.WEBSITE_URL;
const senderEmail = process.env.SENDER_EMAIL;
const platformName = process.env.NOTIFICATION_PLATFORM_NAME || 'the website';
const platformTeam = process.env.NOTIFICATION_PLATFORM_TEAM || 'Admin Team';

export const addAdvertNotification = async ({ type, advert }) => {
  if (type !== 'created' || !advert?.postedBy?.email) return;

 
   

  const ownerHtml = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
  <p>Hi,</p>
  <p>Your advert titled <strong>"${advert.title}"</strong> has been successfully posted on ${platformName}.</p>
  <p>Manage your adverts from the User Dashboard at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a>.</p>
  <p>Adverts are created with a 90-day expiry by default. You can renew your advert from the User Dashboard.</p>
  <p>Thank you,<br/>
  — ${platformTeam}</p>
</div>
  `;

  try {
    await sendEmail({
      to: advert.postedBy.email,
      subject: `Advert "${advert.title}" is live`,
      html: ownerHtml,
    });

    console.log(`✅ Advert creation confirmation sent to ${advert.postedBy.email}`);
  } catch (error) {
    console.error(`❌ Failed to send creation confirmation: ${error.message}`);
  }
};

export const updateAdvertNotification = async ({ type, advert }) => {
  if (type !== 'updated' || !advert?.postedBy?.email) return;



  const htmlContent = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
  <p>Hi,</p>
  <p>Your advert titled <strong>"${advert.title}"</strong> has been successfully updated.</p>
  <p>Manage your adverts from the User Dashboard at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a>.</p>
  <p>Thank you,<br/>
  — ${platformTeam}</p>
</div>

  `;

  try {
    await sendEmail({
      to: advert.postedBy.email,
      subject: `Advert "${advert.title}" is updated`,
      html: htmlContent,
    });

    console.log(`✅ Advert update notification sent to ${advert.postedBy.email}`);
  } catch (error) {
    console.error(`❌ Failed to send update notification: ${error.message}`);
  }
};

export const deleteAdvertNotification = async ({ type, advert }) => {
  if ((type !== 'deleted' && type !== 'deletedByAdmin') || !advert?.postedBy?.email) return;

  let htmlContent;
  
  if (type === 'deletedByAdmin') {
    htmlContent = `
      <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
    <p>Hi,</p>
    <p>Your advert titled <strong>"${advert.title}"</strong> has been removed by the ${platformName} Admin.</p>
    <p>Common reasons for advert deletion include:</p>
<ul>
  <li>Expired adverts are deleted after organisers have been notified and no response has been received.</li>
  <li>The advert was reported as inappropriate.</li>
</ul>
    <p>If you have any questions, please contact us at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a>.</p>
    <p>Regards,<br/>
    — ${platformTeam}</p>
  </div>
    `;
  } else {
    htmlContent = `
      <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
    <p>Hi,</p>
    <p>Your advert titled <strong>"${advert.title}"</strong> has been successfully removed.</p>
    <p>Thank you,<br/>
    — ${platformTeam}</p>
  </div>
    `;
  }

  try {
    await sendEmail({
      to: advert.postedBy.email,
      subject: `Advert "${advert.title}" is removed`,
      html: htmlContent,
    });

    console.log(`✅ Advert deletion notification sent to ${advert.postedBy.email}`);
  } catch (error) {
    console.error(`❌ Failed to send deletion notification: ${error.message}`);
  }
};


export const renewAdvertNotification = async ({ type, advert }) => {
  if (type !== 'renewed' || !advert?.postedBy?.email) return;

  const newExpiryDate = new Date(advert.expiresAt);
  const formattedDate = newExpiryDate.toLocaleDateString('en-AU', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
  <p>Hi,</p>
  <p>Your advert titled <strong>"${advert.title}"</strong> has been successfully renewed for another 90 days.</p>
  <p>New expiry date: ${formattedDate}</p>
  <p>Manage your adverts from the User Dashboard at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a>.</p>
  <p>Thank you,<br/>
  — ${platformTeam}</p>
</div>
  `;

  try {
    await sendEmail({
      to: advert.postedBy.email,
      subject: `Advert "${advert.title}" is renewed`,
      html: htmlContent,
    });

    console.log(`✅ Advert renewal notification sent to ${advert.postedBy.email}`);
  } catch (error) {
    console.error(`❌ Failed to send renewal notification: ${error.message}`);
  }
};