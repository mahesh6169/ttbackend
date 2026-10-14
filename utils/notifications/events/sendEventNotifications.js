/**
 * Last updated: 2025-12-08
 */

import { sendEmail } from '../sendEmail.js';
import dateFnsTz from 'date-fns-tz';
const { formatInTimeZone } = dateFnsTz;

const websiteUrl = process.env.WEBSITE_URL;
const platformName = process.env.NOTIFICATION_PLATFORM_NAME || 'the website';
const platformTeam = process.env.NOTIFICATION_PLATFORM_TEAM || 'Desify Team';

/**
 * - Schemas used: None (uses passed event object)
 * - Called from:
 *     - eventController.js (addFreeEvent) - line 151
 *     - eventController.js (addPaidEvent) - line 488
 * - Purpose: Notifies organizer when they create a new event
 */
export const addEventNotification = async ({ type, event }) => {
  if (type !== 'created' || !event?.postedBy?.email) return;

  // Check if it's a recurring event
  const isRecurring =
    event.recurrence?.isRecurring && !event.recurrence?.parentEventId;

  let recurringMessage = '';
  if (isRecurring) {
    // Format the first event date
    const firstEventDate = formatInTimeZone(
      new Date(event.dateTime),
      event.timeZone || 'Australia/Sydney',
      "EEEE, dd MMMM yyyy 'at' h:mm a",
    );
    recurringMessage = `<p>This is a <strong>recurring event</strong> starting from <strong>${firstEventDate}</strong>.</p>`;
  }

  // Build management links based on event type (paid vs free/RSVP)
  const managementLinks = event.isPaid
    ? `
      <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Manage</strong> : Profile > Events [Host] > Paid Event > Manage</p>
      <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Check-in</strong> : Profile > Events [Host] > Paid Event > Check-in</p>
      <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Orders and Refunds</strong> : Profile > Events [Host] > Paid Event > Orders</p>
    `
    : `
      <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Manage</strong> : Profile > Events [Host] > RSVP Event > Manage</p>
      <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Check-in</strong> : Profile > Events [Host] > RSVP Event > Check-in</p>
    `;

  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
      <p>Hi,</p>
      <p>Your event titled <strong>"${event.title}"</strong> has been successfully posted on ${platformName}.</p>
      ${recurringMessage}
      <p>Manage your events from the User Profile at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a></p>
      ${managementLinks}
      <p>Thank you,<br/>
      — ${platformTeam}</p>
    </div>
  `;

  try {
    await sendEmail({
      to: event.postedBy.email,
      subject: `${event.eventCode} - "${event.title}" is live`,
      html,
      category: 'events', // routes via EMAIL_PROVIDER_EVENTS (shared-email-provider-switch.md D3)
    });
    console.log(`✅ Event creation email sent to ${event.postedBy.email}`);
  } catch (err) {
    console.error(`❌ Failed to send event creation email: ${err.message}`);
  }
};

/**
 * updateEventNotification
 * - Schemas used: None (uses passed event object)
 * - Called from:
 *     - eventController.js (updateFreeEvent) - line 344
 *     - eventController.js (updatePaidEvent) - line 619
 * - Purpose: Notifies organizer when they update their event
 */
export const updateEventNotification = async ({ type, event }) => {
  if (type !== 'updated' || !event?.postedBy?.email) return;

  // Build management links based on event type (paid vs free/RSVP)
  const managementLinks = event.isPaid
    ? `
      <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Manage</strong> : Profile > Events [Host] > Paid Event > Manage</p>
      <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Check-in</strong> : Profile > Events [Host] > Paid Event > Check-in</p>
      <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Orders and Refunds</strong> : Profile > Events [Host] > Paid Event > Orders</p>
    `
    : `
      <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Manage</strong> : Profile > Events [Host] > RSVP Event > Manage</p>
      <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Check-in</strong> : Profile > Events [Host] > RSVP Event > Check-in</p>
    `;

  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
      <p>Hi,</p>
      <p>Your event titled <strong>"${event.title}"</strong> has been successfully updated on ${platformName}.</p>
      <p>Manage your events from the User Profile at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a></p>
      ${managementLinks}
      <p>Thank you,<br/>
      — ${platformTeam}</p>
    </div>
  `;

  try {
    await sendEmail({
      to: event.postedBy.email,
      subject: `${event.eventCode} - "${event.title}" is updated`,
      html,
      category: 'events', // routes via EMAIL_PROVIDER_EVENTS (shared-email-provider-switch.md D3)
    });
    console.log(`✅ Event update email sent to ${event.postedBy.email}`);
  } catch (err) {
    console.error(`❌ Failed to send event update email: ${err.message}`);
  }
};

/**
 * deleteEventNotification
 * - Schemas used: None (uses passed event object)
 * - Called from:
 *     - eventController.js (deleteEvent) - line 809
 *     - manageEventController.js (deleteEventByAdmin) - line 199
 * - Purpose: Notifies organizer when their event is deleted (by them or admin)
 */
export const deleteEventNotification = async ({ type, event }) => {
  if (
    (type !== 'deleted' && type !== 'deletedByAdmin') ||
    !event?.postedBy?.email
  )
    return;

  let html;

  if (type === 'deletedByAdmin') {
    html = `
      <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
        <p>Hi,</p>
<p>Your event titled <strong>"${event.title}"</strong> has been deleted by the ${platformName} Admin.</p>

<p>Common reasons for event deletion include:</p>
<ul>
  <li>Expired events are deleted after organisers have been notified and no response has been received.</li>
  <li>The event was reported as inappropriate.</li>
</ul>

<p>If you have any questions, please contact us at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a>.</p>
<p>Regards,<br/>
— ${platformTeam}</p>

      </div>
    `;
  } else {
    // Build post-deletion links based on event type.
    // Paid events: PaidTickets + EventInvoices are preserved (see deleteEventHelpers.js),
    //   so check-in records and orders/refunds remain accessible.
    // Free events: FreeTickets are wiped on delete (cascadeDeleteFreeEvent),
    //   so there's nothing left for the host to view — no post-deletion links.
    const postDeleteLinks = event.isPaid
      ? `
        <p>You can still manage orders and check-in details from your Profile at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a></p>
        <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Check-in</strong> : Profile > Events [Host] > Paid Event > Check-in</p>
        <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Orders and Refunds</strong> : Profile > Events [Host] > Paid Event > Orders</p>
      `
      : '';

    html = `
      <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
        <p>Hi,</p>
        <p>Your event titled <strong>"${event.title}"</strong> has been successfully deleted.</p>
        ${postDeleteLinks}
        <p>Thank you,<br/>
        — ${platformTeam}</p>
      </div>
    `;
  }

  try {
    await sendEmail({
      to: event.postedBy.email,
      subject: `${event.eventCode} - "${event.title}" is deleted`,
      html,
      category: 'events', // routes via EMAIL_PROVIDER_EVENTS (shared-email-provider-switch.md D3)
    });
    console.log(`✅ Event deletion email sent to ${event.postedBy.email}`);
  } catch (err) {
    console.error(`❌ Failed to send event deletion email: ${err.message}`);
  }
};
