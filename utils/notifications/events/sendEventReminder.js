/**
 * Last updated: 2025-12-08
 */

import { sendEmail } from '../sendEmail.js';

const websiteUrl = process.env.WEBSITE_URL;
const platformName = process.env.NOTIFICATION_PLATFORM_NAME || 'the website';
const platformTeam = process.env.NOTIFICATION_PLATFORM_TEAM || 'Desify Team';

export const sendEventReminder = async (event, type) => {
  let subject, html;

  // Pick the right Manage breadcrumb based on event type
  const eventTypeLabel = event.isPaid ? 'Paid Event' : 'RSVP Event';
  const manageBreadcrumb = `<p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Manage</strong> : Profile > Events [Host] > ${eventTypeLabel} > Manage</p>`;

  if (type === '1') {
    subject = `Your event "${event.title}" has ended`;

    html = `
      <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
        <p>Hi,</p>
        <p>Your event <strong>"${event.title}"</strong> has ended.</p>
        <p>Please delete it from the User Profile at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a></p>
        ${manageBreadcrumb}
        <p>Thank you,<br/>
        — ${platformTeam}</p>
      </div>
    `;

  } else if (type === '2') {
    subject = `Your event "${event.title}" will be deleted soon`;

    html = `
      <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
        <p>Hi,</p>
        <p>Your event <strong>"${event.title}"</strong> will be deleted soon.</p>
        <p>Please delete it from the User Profile at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a> if you no longer need it.</p>
        ${manageBreadcrumb}
        <p>Thank you,<br/>
        — ${platformTeam}</p>
      </div>
    `;
    
  } else {
    throw new Error('Invalid reminder type');
  }

  try {
    await sendEmail({
      to: event.postedBy.email,
      subject,
      html,
      category: 'events', // routes via EMAIL_PROVIDER_EVENTS (shared-email-provider-switch.md D3)
    });
    console.log(`✅ Event reminder type ${type} sent to: ${event.postedBy.email}`);
  } catch (error) {
    console.error(`❌ Failed to send event reminder type ${type}:`, error.message);
    throw error;
  }
};