import { sendEmail } from '../sendEmail.js';

const websiteUrl = process.env.WEBSITE_URL;
const platformName = process.env.NOTIFICATION_PLATFORM_NAME || 'the website';
const platformTeam = process.env.NOTIFICATION_PLATFORM_TEAM || 'Admin Team';

/* Welcome Email */
export const sendWelcomeEmail = async (user) => {
  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
      <p>Hi ${user.name},</p>
      <p>Welcome to ${platformName}! Your account has been successfully created.</p>
      <p>You can now explore the community at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a>.</p>
      <p>Thank you,<br/>
      — ${platformTeam}</p>
    </div>
  `;

  try {
    await sendEmail({
      to: user.email,
      subject: `Welcome to ${platformName}`,
      html,
      category: 'signin', // pilot: routes via EMAIL_PROVIDER_SIGNIN (shared-email-provider-switch.md D3)
    });
    console.log('✅ Welcome email sent to:', user.email);
  } catch (error) {
    console.error('❌ Error sending welcome email:', error.message);
  }
};


/* Verify OTP Email */
export const sendVerifyOtpEmail = async ({ email, name, otp }) => {
  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
      <p>Hi ${name},</p>
      <p>Your verification code for ${platformName} is:</p>
      <p style="font-size: 24px; font-weight: bold; color: #3b82f6; margin: 20px 0;">${otp}</p>
      <p>This code is valid for 15 minutes.</p>
      <p>If you closed the registration page, you can enter your code at:<br/>
      <a href="${websiteUrl}/users/emailverify" style="color: #3b82f6;">${websiteUrl}/users/emailverify</a></p>
      <p>If you didn't request this code, you can safely ignore this email.</p>
      <p>Thank you,<br/>
      — ${platformTeam}</p>
    </div>
  `;

  try {
    await sendEmail({
      to: email,
      subject: `Your ${platformName} verification code`,
      html,
      category: 'signin', // pilot: routes via EMAIL_PROVIDER_SIGNIN (shared-email-provider-switch.md D3)
    });
    console.log('✅ OTP verification email sent to:', email);
  } catch (error) {
    console.error('❌ Error sending OTP email:', error.message);
  }
};


export const sendResetOtpEmail = async ({ email, name, otp }) => {
  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
      <p>Hi ${name},</p>
      <p>We received a request to reset your ${platformName} password.</p>
      <p>Your password reset code is:</p>
      <p style="font-size: 24px; font-weight: bold; color: #3b82f6; margin: 20px 0;">${otp}</p>
      <p>This code is valid for 15 minutes.</p>
      <p>If you didn't request this reset, you can safely ignore this email.</p>
      <p>Thank you,<br/>
      — ${platformTeam}</p>
    </div>
  `;

  try {
    await sendEmail({
      to: email,
      subject: `Your ${platformName} password reset code`,
      html,
      category: 'signin', // account/auth mail: routes via EMAIL_PROVIDER_SIGNIN (shared-email-provider-switch.md D3)
    });
    console.log('✅ Reset OTP email sent to:', email);
  } catch (error) {
    console.error('❌ Error sending reset OTP email:', error.message);
    throw error;
  }
};

/* Account Deletion Email */
export const sendAccountDeletionEmail = async (user, deletedByAdmin = false) => {
  let html;
  
  if (deletedByAdmin) {
    // Admin-initiated deletion
    html = `
      <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
        <p>Hi ${user.name},</p>
        <p>Your ${platformName} account has been removed by the ${platformTeam}.</p>
        <p>All your data including adverts, events, threads, and messages have been removed.</p>
        <p>If you have any questions, please contact us at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a>.</p>
        <p>Regards,<br/>
        — ${platformTeam}</p>
      </div>
    `;
  } else {
    // User-initiated deletion
    html = `
      <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
        <p>Hi ${user.name},</p>
        <p>Your ${platformName} account has been successfully deleted.</p>
        <p>All your data including adverts, events, threads, and messages have been removed.</p>
        <p>We're sorry to see you go. If you change your mind, you're always welcome to create a new account at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a>.</p>
        <p>Thank you,<br/>
        — ${platformTeam}</p>
      </div>
    `;
  }

  try {
    await sendEmail({
      to: user.email,
      subject: `Your ${platformName} account has been ${deletedByAdmin ? 'removed' : 'deleted'}`,
      html,
      category: 'signin', // account/auth mail: routes via EMAIL_PROVIDER_SIGNIN (shared-email-provider-switch.md D3)
    });
    console.log('✅ Account deletion email sent to:', user.email);
  } catch (error) {
    console.error('❌ Error sending account deletion email:', error.message);
    // Don't throw error as account is already deleted
  }
};

