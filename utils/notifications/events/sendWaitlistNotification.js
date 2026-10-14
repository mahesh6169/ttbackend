import dateFnsTz from 'date-fns-tz';
import { sendEmail } from '../sendEmail.js';
import { generateSlug } from '../../helpers/shared/generateSlug.js';

const { formatInTimeZone } = dateFnsTz;

// Send ONE "tickets available again" email to a single waitlisted person. The caller loops over
// unnotified entries and sends individually (never a bulk visible-recipients send) so addresses
// stay private. The button points to the PUBLIC event slug page - identical for guests and
// members, with no member-only breadcrumbs (the guest-email lesson). Returns true on success so
// the caller only stamps notifiedAt when the email actually went out.
// See featureplans/events-waitlist.md.
export const sendWaitlistAvailableEmail = async (event, toEmail) => {
  const timeZone = event.timeZone || 'Australia/Sydney';
  const dateFormatted = formatInTimeZone(new Date(event.dateTime), timeZone, 'EEEE, dd MMMM yyyy');
  const timeFormatted = formatInTimeZone(new Date(event.dateTime), timeZone, 'h:mm a');

  const platformName = process.env.NOTIFICATION_PLATFORM_NAME || 'Desify';
  const websiteUrl = process.env.WEBSITE_URL || '';
  const eventUrl = `${websiteUrl}/events/${generateSlug(event.title)}-${event._id}`;

  const venueLine = [event.venue, event.address?.formattedAddress].filter(Boolean).join(', ');

  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
      <h2 style="color: #0f766e; margin-top: 0;">Tickets available again</h2>
      <p>Good news - spots have opened up for an event you joined the waitlist for. First come, first served.</p>

      <div style="margin: 20px 0;">
        <table style="border-collapse: collapse; border: 1px solid #d1d5db; border-radius: 8px; width: auto;">
          <tr>
            <td colspan="2" style="background-color: #f9fafb; padding: 15px; border-bottom: 1px solid #d1d5db; font-weight: bold;">Event Details</td>
          </tr>
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Event</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${event.title}</td>
          </tr>
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Date</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${dateFormatted}</td>
          </tr>
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Time</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${timeFormatted} (${timeZone})</td>
          </tr>
          <tr>
            <td style="padding: 12px;"><strong>Venue</strong></td>
            <td style="padding: 12px;">${venueLine || 'See event page'}</td>
          </tr>
        </table>
      </div>

      <div style="margin: 24px 0;">
        <a href="${eventUrl}" style="display: inline-block; background-color: #0f766e; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: bold;">Get your tickets</a>
      </div>

      <p style="font-size: 12px; color: #6b7280; margin-top: 24px;">You are receiving this because you joined the waitlist for this event.</p>
      <p style="font-size: 12px; color: #6b7280;">- ${platformName}</p>
    </div>
  `;

  try {
    await sendEmail({
      to: toEmail,
      subject: `Tickets available again - ${event.title}`,
      html,
      category: 'events', // routes via EMAIL_PROVIDER_EVENTS (shared-email-provider-switch.md D3)
    });
    console.log(`waitlist notification sent to ${toEmail} for event ${event._id}`);
    return true;
  } catch (error) {
    console.error(`failed to send waitlist notification to ${toEmail}:`, error.message);
    return false;
  }
};
