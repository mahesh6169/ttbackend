/**
 * Last updated: 2025-12-08
 */

import { sendEmail } from '../sendEmail.js';
import dateFnsTz from 'date-fns-tz';
import QRCode from 'qrcode';
import { generateSlug } from '../../helpers/shared/generateSlug.js';
import { summarizeSaleLines } from '../../events/ticketHelpers.js';
const { formatInTimeZone } = dateFnsTz;

const websiteUrl = process.env.WEBSITE_URL;
const platformName = process.env.NOTIFICATION_PLATFORM_NAME || 'the website';
const platformTeam = process.env.NOTIFICATION_PLATFORM_TEAM || 'Desify Team';

/**
 * Generate QR code as Buffer for email attachment
 */
const generateQRCodeBuffer = async (ticketNumber) => {
  try {
    const buffer = await QRCode.toBuffer(ticketNumber, {
      width: 300,
      margin: 2,
      errorCorrectionLevel: 'H',
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      },
      type: 'png'
    });
    return buffer;
  } catch (error) {
    console.error(`Failed to generate QR code for ${ticketNumber}:`, error);
    return null;
  }
};

/**
 * Refund policy + organiser Terms & Conditions block for the buyer email (events-terms-conditions.md).
 * Pure + exported so it is testable. Returns '' when there is nothing to show (an empty policy renders
 * nothing anywhere).
 */
export const buildRefundAndTermsBlockHtml = (refundPolicy = {}) => {
  const rp = refundPolicy || {};
  if (!rp.processingFeePolicy && !rp.policyText && !rp.termsAndConditions) return '';
  const fees = rp.processingFeePolicy === 'refunded' ? 'refundable' : 'non-refundable';
  return `
      <div style="margin-bottom: 20px;">
        <h3 style="color: #374151; margin-bottom: 10px;">Refund policy &amp; terms</h3>
        <p style="margin: 5px 0; font-size: 13px;"><strong>Refund Policy:</strong> Processing fees are ${fees}.${rp.policyText ? ` ${rp.policyText}` : ''}</p>
        ${rp.termsAndConditions ? `<p style="margin: 5px 0; font-size: 13px; white-space: pre-line;"><strong>Terms &amp; Conditions:</strong> ${rp.termsAndConditions}</p>` : ''}
      </div>`;
};

/**
 * Send ticket purchase confirmation email to buyer
 */
export const sendTicketPurchaseConfirmationToBuyer = async ({ invoice, tickets, event }) => {
  if (!invoice?.buyer?.email) return;

  const eventDate = event.timeZone 
    ? formatInTimeZone(
        new Date(event.dateTime),
        event.timeZone,
        'EEEE, dd MMMM yyyy'
      )
    : new Date(event.dateTime).toLocaleDateString('en-AU', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      });
  
  const eventTime = event.timeZone
    ? formatInTimeZone(
        new Date(event.dateTime),
        event.timeZone,
        'h:mm a'
      )
    : new Date(event.dateTime).toLocaleTimeString('en-AU', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });

  const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-AU', {
      style: 'currency',
      currency: 'AUD',
    }).format(amount);
  };

  // Generate QR codes as attachments
  const attachments = [];
  const ticketsWithCID = [];
  
  for (let idx = 0; idx < tickets.length; idx++) {
    const ticket = tickets[idx];
    const plainTicket = ticket.toObject ? ticket.toObject() : ticket;
    const qrBuffer = await generateQRCodeBuffer(plainTicket.ticketNumber);
    
    if (qrBuffer) {
      const cid = `qr-${plainTicket.ticketNumber}@ticket`;
      attachments.push({
        filename: `${plainTicket.ticketNumber}.png`,
        content: qrBuffer.toString('base64'),
        disposition: 'inline',
        id: cid
      });
      ticketsWithCID.push({ ...plainTicket, qrCID: cid });
    } else {
      ticketsWithCID.push({ ...plainTicket, qrCID: null });
    }
  }

  // Ticket notes (display-only, per ticket type): show each PURCHASED type's note once, in one
  // block, rather than repeating it on every ticket card. Types with no note are skipped; if no
  // purchased type has a note the block is omitted. See featureplans/events-tickettype-note.md.
  const purchasedTypeNames = [...new Set(ticketsWithCID.map((t) => t.ticketType?.name).filter(Boolean))];
  const ticketNotes = purchasedTypeNames
    .map((name) => {
      const tt = (event.ticketTypes || []).find((t) => t.name === name);
      return tt && tt.note ? { name, note: tt.note } : null;
    })
    .filter(Boolean);

  // Itemised purchase summary. A bundle pack shows as ONE line ("Type (admits N)") at the pack's
  // paid total, never N odd-cent lines; singles group by type (events-bundle-pricing.md D8). The
  // per-line amounts are the actual paid prices, so they sum to Total Amount.
  const saleLines = summarizeSaleLines(tickets);
  const lineLabel = (g) => (g.isPack ? `${g.type} (admits ${g.admits})` : `${g.count} x ${g.type}`);
  const purchasedRows = saleLines
    .map((g) => `
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${lineLabel(g)}</td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db; text-align: right;">${formatCurrency(g.amount)}</td>
          </tr>`)
    .join('');
  const discount = invoice.amounts?.discount;
  const discountNote = discount && discount.amount > 0
    ? `<p style="margin: 8px 0 0 0; font-size: 13px; color: #4b5563;">A discount${discount.code ? ` (${discount.code})` : ''} of ${formatCurrency(discount.amount)} has been applied.</p>`
    : '';

  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333; max-width: 600px;">
      <!-- Event summary -->
      <div style="margin-bottom: 20px;">
        <p style="font-size: 18px; font-weight: bold; margin: 0 0 10px 0;">${event.title}</p>
        <p style="margin: 4px 0;"><strong>Date:</strong> ${eventDate}</p>
        <p style="margin: 4px 0;"><strong>Time:</strong> ${eventTime}${event.timeZone ? ` (${event.timeZone})` : ''}</p>
        ${event.venue ? `<p style="margin: 4px 0;"><strong>Venue:</strong> ${event.venue}</p>` : ''}
        ${event.address ? `<p style="margin: 4px 0;"><strong>Address:</strong> ${event.address}</p>` : ''}
      </div>

      <!-- Invoice + itemised purchase + totals (no heading) -->
      <div style="margin-bottom: 20px;">
        <table style="border-collapse: collapse; border: 1px solid #d1d5db; border-radius: 8px; width: 100%;">
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db; width: 40%;"><strong>Invoice</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db; text-align: right;">${invoice.invoiceNumber}</td>
          </tr>
          ${purchasedRows}
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Total Tickets</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db; text-align: right;">${tickets.length}</td>
          </tr>
          <tr>
            <td style="padding: 12px;"><strong>Total Amount</strong></td>
            <td style="padding: 12px; font-weight: bold; color: #16a34a; text-align: right;">
              ${formatCurrency(invoice.amounts.total)}${event.gstIncluded ? ' (incl. GST)' : ''}
            </td>
          </tr>
        </table>
        ${discountNote}
      </div>
      
      ${ticketNotes.length > 0 ? `
      <!-- Ticket notes (display-only; per ticket type) -->
      <div style="margin-bottom: 20px;">
        <h3 style="color: #374151; margin-bottom: 10px;">Ticket notes</h3>
        <table style="border-collapse: collapse; border: 1px solid #d1d5db; border-radius: 8px; width: 100%;">
          ${ticketNotes.map((tn, i) => `
          <tr>
            <td style="padding: 10px 12px; ${i < ticketNotes.length - 1 ? 'border-bottom: 1px solid #d1d5db;' : ''} width: 30%; vertical-align: top;"><strong style="text-transform: capitalize;">${tn.name}</strong></td>
            <td style="padding: 10px 12px; ${i < ticketNotes.length - 1 ? 'border-bottom: 1px solid #d1d5db;' : ''} color: #4b5563;">${tn.note}</td>
          </tr>
          `).join('')}
        </table>
      </div>
      ` : ''}

      <!-- Tickets Section -->
      <div style="margin-bottom: 20px;">
        ${ticketsWithCID.map((ticket, index) => {
          const hasSeat = ticket.seats && ticket.seats.length > 0;
          const seatInfo = hasSeat 
            ? ticket.seats.map(s => `${s.row}-${s.seatNumber}`).join(', ')
            : null;
          
          const ticketTypeName = ticket.ticketType?.name || 'Standard';
          // Per-ticket QR card carries no price: a bundle ticket's odd-cent share would contradict
          // the one-line pack price in the summary above (events-bundle-pricing.md D8).

          return `
        <!-- Ticket Card ${index + 1} -->
        <div style="border: 2px solid #d1d5db; border-radius: 8px; padding: 20px; margin-bottom: 15px; background-color: #ffffff;">
          <div style="text-align: center; margin-bottom: 15px;">
            <p style="margin: 0 0 5px 0; font-size: 12px; color: #6b7280; font-weight: 600; text-transform: uppercase;">Ticket ${index + 1} of ${tickets.length}</p>
          </div>
          
          <!-- QR Code -->
          <div style="text-align: center; margin-bottom: 20px;">
            ${ticket.qrCID ? `
            <img src="cid:${ticket.qrCID}" 
                 alt="Ticket QR Code" 
                 width="200" 
                 height="200"
                 style="display: block; margin: 0 auto; border: 3px solid #0d9488; border-radius: 8px; padding: 10px; background-color: #ffffff;" />
            ` : `
            <div style="width: 200px; height: 200px; margin: 0 auto; border: 2px dashed #d1d5db; display: flex; align-items: center; justify-content: center;">
              <p style="color: #9ca3af; font-size: 12px;">QR Code Unavailable</p>
            </div>
            `}
          </div>
          
          <!-- Ticket Details -->
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb;">
                <span style="color: #6b7280; font-size: 13px;">Ticket Number</span>
              </td>
              <td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb; text-align: right;">
                <span style="font-weight: 600; font-size: 13px; font-family: monospace;">${ticket.ticketNumber}</span>
              </td>
            </tr>
            <tr>
              <td style="padding: 8px 0; ${hasSeat ? 'border-bottom: 1px solid #e5e7eb;' : ''}">
                <span style="color: #6b7280; font-size: 13px;">Type</span>
              </td>
              <td style="padding: 8px 0; text-align: right; ${hasSeat ? 'border-bottom: 1px solid #e5e7eb;' : ''}">
                <span style="font-weight: 600; font-size: 13px; text-transform: capitalize;">${ticketTypeName}</span>
              </td>
            </tr>
            ${hasSeat ? `
            <tr>
              <td style="padding: 8px 0;">
                <span style="color: #6b7280; font-size: 13px;">Seat</span>
              </td>
              <td style="padding: 8px 0; text-align: right;">
                <span style="font-weight: 600; font-size: 13px;">${seatInfo}</span>
              </td>
            </tr>
            ` : ''}
          </table>
        </div>
          `;
        }).join('')}
      </div>
      
      <!-- Header Table: Event Organizer Details -->
      <div style="margin-bottom: 20px;">
        <table style="border-collapse: collapse; border: 1px solid #d1d5db; border-radius: 8px; width: auto;">
          ${event.organizer?.name ? `
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db; width: 40%;"><strong>Organizer</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${event.organizer.name}</td>
          </tr>
          ` : ''}
          ${event.organizer?.email ? `
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Email</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><a href="mailto:${event.organizer.email}" style="color: #3b82f6;">${event.organizer.email}</a></td>
          </tr>
          ` : ''}
          ${event.organizer?.phone || event.organizer?.contact ? `
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Phone</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${event.organizer.phone || event.organizer.contact}</td>
          </tr>
          ` : ''}
          ${event.organizer?.website ? `
          <tr>
            <td style="padding: 12px;"><strong>Website</strong></td>
            <td style="padding: 12px;"><a href="${event.organizer.website}" target="_blank" style="color: #3b82f6;">${event.organizer.website}</a></td>
          </tr>
          ` : ''}
        </table>
      </div>
      
      ${buildRefundAndTermsBlockHtml(event.refundPolicy)}

      <div style="margin-bottom: 20px;">
        <h3 style="color: #374151; margin-bottom: 10px;">Registered users</h3>
        <p>View your event details, tickets, and invoices at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a></p>
        <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Event Details</strong> : <a href="${websiteUrl}/events/${generateSlug(event.title)}-${tickets[0].event}" style="color: #3b82f6;">${event.title}</a></p>
        <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>View Tickets</strong> : Profile > Events [attendee] > Paid Tickets</p>
        <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>View Invoices</strong> : Profile > Events [attendee] > Invoices</p>
      </div>

      <p>Thank you for your purchase!<br/>
      — ${platformTeam}</p>
    </div>
  `;

  try {
    await sendEmail({
      to: invoice.buyer.email,
      subject: `Tickets Confirmed: ${event.title}`,
      html,
      attachments,
      category: 'events', // routes via EMAIL_PROVIDER_EVENTS; buyer email carries inline QR attachments (shared-email-provider-switch.md D3)
    });

    console.log(`Ticket purchase confirmation sent to ${invoice.buyer.email}`);
  } catch (error) {
    console.error(`Failed to send ticket purchase confirmation: ${error.message}`);
    throw error;
  }
};

/**
 * Send notification to event organizer about new ticket sale
 */
export const sendTicketSaleNotificationToOrganizer = async ({ invoice, tickets, event, organizerEmail }) => {
  if (!organizerEmail) return;

  const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-AU', {
      style: 'currency',
      currency: 'AUD',
    }).format(amount);
  };

  // Build seat summary - just show seat numbers
  const allSeats = tickets
    .filter(t => t.seats && t.seats.length > 0)
    .flatMap(t => t.seats.map(s => `${s.row}${s.seatNumber}`));
  
  const seatSummary = allSeats.length > 0 ? allSeats.join(', ') : '';

  // Build the purchased-lines summary. A bundle pack shows as ONE line ("Type (admits N)") at the
  // pack's paid total, never N odd-cent lines; singles group by type (events-bundle-pricing.md D8).
  // Amounts are summed from each ticket's stored paid price, so they reconcile with Total Amount.
  const saleLines = summarizeSaleLines(tickets);
  const saleLinesHtml = saleLines
    .map((g) => g.isPack
      ? `${g.type} (admits ${g.admits}) - ${formatCurrency(g.amount)}`
      : `${g.count} x ${g.type} - ${formatCurrency(g.amount)}`)
    .join('<br/>');

  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333; max-width: 600px;">
      <!-- Lead: event title + one-line context (no hero box) -->
      <p style="font-size: 18px; font-weight: bold; margin: 0 0 4px 0;">${event.title}</p>
      <p style="margin: 0 0 20px 0;">New ticket sale</p>

      <!-- Sale (compact, no heading) -->
      <div style="margin-bottom: 20px;">
        <table style="border-collapse: collapse; border: 1px solid #d1d5db; border-radius: 8px; width: 100%;">
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db; width: 40%;"><strong>Invoice</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${invoice.invoiceNumber}</td>
          </tr>
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Total Amount</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">
              ${formatCurrency(invoice.amounts.total)}${event.gstIncluded ? ' (incl. GST)' : ''}
            </td>
          </tr>
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Total Tickets</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${tickets.length}</td>
          </tr>
          <tr>
            <td style="padding: 12px;${seatSummary ? ' border-bottom: 1px solid #d1d5db;' : ''}"><strong>Tickets Purchased</strong></td>
            <td style="padding: 12px;${seatSummary ? ' border-bottom: 1px solid #d1d5db;' : ''}">
              ${saleLinesHtml}
            </td>
          </tr>
          ${seatSummary ? `
          <tr>
            <td style="padding: 12px;"><strong>Seats Assigned</strong></td>
            <td style="padding: 12px;">${seatSummary}</td>
          </tr>
          ` : ''}
        </table>
      </div>

      <!-- Buyer (compact, no heading) -->
      <div style="margin-bottom: 20px;">
        <table style="border-collapse: collapse; border: 1px solid #d1d5db; border-radius: 8px; width: 100%;">
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db; width: 40%;"><strong>Name</strong></td>
            <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${invoice.buyer.firstName} ${invoice.buyer.lastName}</td>
          </tr>
          <tr>
            <td style="padding: 12px;${invoice.buyer.phone ? ' border-bottom: 1px solid #d1d5db;' : ''}"><strong>Email</strong></td>
            <td style="padding: 12px;${invoice.buyer.phone ? ' border-bottom: 1px solid #d1d5db;' : ''}">${invoice.buyer.email}</td>
          </tr>
          ${invoice.buyer.phone ? `
          <tr>
            <td style="padding: 12px;"><strong>Phone</strong></td>
            <td style="padding: 12px;">${invoice.buyer.phone}</td>
          </tr>
          ` : ''}
        </table>
      </div>
      
      <p>Manage your events from the User Profile at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a></p>
      <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Manage</strong> : Profile > Events [Host] > Paid Event > Manage</p>
      <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Check-in</strong> : Profile > Events [Host] > Paid Event > Check-in</p>
      <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Orders and Refunds</strong> : Profile > Events [Host] > Paid Event > Orders</p>
      
      <p>Thank you,<br/>
      — ${platformTeam}</p>
    </div>
  `;

  try {
    await sendEmail({
      to: organizerEmail,
      subject: `New Ticket Sale: ${event.title}`,
      html,
      category: 'events', // routes via EMAIL_PROVIDER_EVENTS (shared-email-provider-switch.md D3)
    });

    console.log(`✅ Ticket sale notification sent to organizer ${organizerEmail}`);
  } catch (error) {
    console.error(`❌ Failed to send organizer notification: ${error.message}`);
    // Don't throw error for organizer email - it's not critical
  }
};