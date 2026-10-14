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
 * Send refund confirmation email to buyer
 */
export const sendRefundConfirmationToBuyer = async ({ tickets, invoice, refundDetails }) => {
  if (!invoice?.buyer?.email) return;

  // Get event details from the first ticket's eventSnapshot
  const eventSnapshot = tickets[0]?.eventSnapshot;
  if (!eventSnapshot) {
    console.error('❌ No eventSnapshot available for refund email');
    return;
  }

  const eventDate = formatInTimeZone(
    new Date(eventSnapshot.dateTime),
    eventSnapshot.timeZone || 'Australia/Sydney',
    'EEEE, dd MMMM yyyy'
  );
  
  const eventTime = formatInTimeZone(
    new Date(eventSnapshot.dateTime),
    eventSnapshot.timeZone || 'Australia/Sydney',
    'h:mm a'
  );

  const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-AU', {
      style: 'currency',
      currency: 'AUD',
    }).format(amount);
  };

  // Actual refund timestamp (falls back to now if not provided).
  const refundDateStr = new Date(refundDetails.refundedAt || Date.now()).toLocaleDateString('en-AU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });

  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333; max-width: 600px;">
      <!-- Refund details (compact, no heading — like the purchase email) -->
      <div style="margin-bottom: 12px;">
        <table style="border-collapse: collapse; border: 1px solid #d1d5db; border-radius: 8px; width: 100%;">
          ${refundDetails.refundRequestId ? `
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db; width: 40%;"><strong>Refund ID</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${refundDetails.refundRequestId}</td>
          </tr>
          ` : ''}
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db; width: 40%;"><strong>Invoice Reference</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${invoice.invoiceNumber}</td>
          </tr>
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Refund Date</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${refundDateStr}</td>
          </tr>
          <tr>
            <td style="padding: 12px;${eventSnapshot.refundPolicy ? ' border-bottom: 1px solid #d1d5db;' : ''}"><strong>Total Refunded</strong></td>
            <td style="padding: 12px;${eventSnapshot.refundPolicy ? ' border-bottom: 1px solid #d1d5db;' : ''} font-weight: bold;">${formatCurrency(refundDetails.totalAmount)}</td>
          </tr>
          ${eventSnapshot.refundPolicy ? `
          <tr>
            <td colspan="2" style="padding: 12px;">
              <strong>Refund Policy:</strong><br/>
              Processing fees are ${eventSnapshot.refundPolicy.processingFeePolicy === 'refundable' ? 'refundable' : 'non-refundable'}.<br/>
              ${eventSnapshot.refundPolicy.policyText || ''}
            </td>
          </tr>
          ` : ''}
        </table>
      </div>

      <!-- Note under the table: red text, no background -->
      <p style="margin: 0 0 20px 0; color: #dc2626; font-size: 13px;">Your refund will be credited to your original payment method within 5-10 business days. The refunded tickets are no longer valid for entry.</p>
      
      <!-- Header Table: Event Details -->
      <div style="margin-bottom: 20px;">
        <table style="border-collapse: collapse; border: 1px solid #d1d5db; border-radius: 8px; width: auto;">
          <tr>
            <td colspan="2" style="background-color: #f9fafb; padding: 15px; border-bottom: 1px solid #d1d5db; font-weight: bold;">Event Details</td>
          </tr>
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Event</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${eventSnapshot.title}</td>
          </tr>
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Date</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${eventDate}</td>
          </tr>
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Time</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${eventTime} (${eventSnapshot.timeZone || 'Australia/Sydney'})</td>
          </tr>
          ${eventSnapshot.venue ? `
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Venue</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${eventSnapshot.venue}</td>
          </tr>
          ` : ''}
          ${eventSnapshot.address ? `
          <tr>
            <td style="padding: 12px;"><strong>Address</strong></td>
            <td style="padding: 12px;">${eventSnapshot.address}</td>
          </tr>
          ` : ''}
        </table>
      </div>
      
      ${eventSnapshot.organizer ? `
      <!-- Header Table: Event Organiser Contact -->
      <div style="margin-bottom: 20px;">
        <table style="border-collapse: collapse; border: 1px solid #d1d5db; border-radius: 8px; width: auto;">
          <tr>
            <td colspan="2" style="background-color: #f9fafb; padding: 15px; border-bottom: 1px solid #d1d5db; font-weight: bold;">Event Organiser Contact</td>
          </tr>
          ${eventSnapshot.organizer.name ? `
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Name</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${eventSnapshot.organizer.name}</td>
          </tr>
          ` : ''}
          ${eventSnapshot.organizer.email ? `
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Email</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><a href="mailto:${eventSnapshot.organizer.email}" style="color: #3b82f6;">${eventSnapshot.organizer.email}</a></td>
          </tr>
          ` : ''}
          ${eventSnapshot.organizer.phone ? `
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Phone</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${eventSnapshot.organizer.phone}</td>
          </tr>
          ` : ''}
          ${eventSnapshot.organizer.website ? `
          <tr>
            <td style="padding: 12px;"><strong>Website</strong></td>
            <td style="padding: 12px;"><a href="${eventSnapshot.organizer.website}" target="_blank" style="color: #3b82f6;">${eventSnapshot.organizer.website}</a></td>
          </tr>
          ` : ''}
        </table>
      </div>
      ` : ''}
      
      <p>For any questions about this refund, please contact the organiser directly. The Desify Team does not manage event refunds.</p>

      <div style="margin-bottom: 20px;">
        <h3 style="color: #374151; margin-bottom: 10px;">Registered users</h3>
        <p>View your invoices at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a></p>
        <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>View Invoices</strong> : Profile > Events [attendee] > Invoices</p>
      </div>

      <p>Thank you,<br/>
      — ${platformTeam}</p>
    </div>
  `;

  try {
    await sendEmail({
      to: invoice.buyer.email,
      subject: `Refund Processed: ${eventSnapshot.title}`,
      html,
      category: 'events', // routes via EMAIL_PROVIDER_EVENTS (shared-email-provider-switch.md D3)
    });

    console.log(`✅ Refund confirmation email sent to ${invoice.buyer.email}`);
  } catch (error) {
    console.error(`❌ Failed to send refund confirmation email: ${error.message}`);
    throw error;
  }
};