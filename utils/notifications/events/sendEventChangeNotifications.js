/**
 * Last updated: 2025-12-08
 */

import { sendEmail } from '../sendEmail.js';
import Event from '../../../models/eventModel.js';
import EventInvoice from '../../../models/eventInvoice.js';
import FreeTicket from '../../../models/freeTicket.js';
import dateFnsTz from 'date-fns-tz';
const { formatInTimeZone } = dateFnsTz;

const websiteUrl = process.env.WEBSITE_URL;
const platformName = process.env.NOTIFICATION_PLATFORM_NAME || 'the website';
const platformTeam = process.env.NOTIFICATION_PLATFORM_TEAM || 'Desify Team';

/**
 * Send generic event update notification to all ticket holders
  * - Schemas used: Event, EventInvoice, FreeTicket
 * - Called from:
 *     - eventController.js (updateFreeEvent) - line 364
 *     - eventController.js (updatePaidEvent) - line 641
 * - Purpose: Notifies all attendees/buyers when event details change
 */
export const sendEventUpdateNotification = async (eventId, eventSnapshot) => {
  try {
    console.log(`📧 Preparing to send update notifications for event ${eventId}`);
    
    // Check if event has already passed - no point notifying about past events
    const eventDate = new Date(eventSnapshot.dateTime);
    const now = new Date();
    
    if (eventDate < now) {
      console.log(`📅 Event "${eventSnapshot.title}" has already passed (${eventDate.toISOString()}). Skipping attendee update notifications.`);
      return;
    }
    
    const uniqueAttendees = new Map();
    
    // Check if event is paid or free
    const event = await Event.findById(eventId).select('isPaid');
    
    if (!event) {
      console.log('Event not found');
      return;
    }
    
    if (event.isPaid) {
      // Get all unique buyer emails for paid events from EventInvoice
      const invoices = await EventInvoice.find({
        event: eventId,
        status: { $ne: 'cancelled' } // Don't send to cancelled invoices
      }).select('buyer.email buyer.firstName buyer.lastName eventSnapshot');

      invoices.forEach(invoice => {
        if (invoice.buyer?.email) {
          uniqueAttendees.set(invoice.buyer.email, {
            email: invoice.buyer.email,
            firstName: invoice.buyer.firstName || '',
            lastName: invoice.buyer.lastName || ''
          });
        }
      });
    } else {
      // Get all unique attendee emails for free events from FreeTicket
      const freeTickets = await FreeTicket.find({
        event: eventId,
        status: { $in: ['registered', 'checkedin'] }
      }).populate('user', 'name').select('user email attendees');

      freeTickets.forEach(ticket => {
        if (ticket.email) {
          // Get the first name from the user if populated, otherwise use first attendee name
          let firstName = '';
          if (ticket.user?.name) {
            firstName = ticket.user.name.split(' ')[0];
          } else if (ticket.attendees && ticket.attendees.length > 0) {
            firstName = ticket.attendees[0].name.split(' ')[0];
          }
          
          uniqueAttendees.set(ticket.email, {
            email: ticket.email,
            firstName: firstName,
            lastName: ''
          });
        }
      });
    }

    if (uniqueAttendees.size === 0) {
      console.log('No attendees/buyers found for event update notification');
      return;
    }

    console.log(`Found ${uniqueAttendees.size} unique ${event.isPaid ? 'buyers' : 'attendees'} to notify`);

    const eventDateFormatted = formatInTimeZone(
      new Date(eventSnapshot.dateTime),
      eventSnapshot.timeZone || 'Australia/Sydney',
      'EEEE, dd MMMM yyyy'
    );
    
    const eventTime = formatInTimeZone(
      new Date(eventSnapshot.dateTime),
      eventSnapshot.timeZone || 'Australia/Sydney',
      'h:mm a'
    );

    // Check if it's a recurring event
    const isRecurring = eventSnapshot.recurrence?.isRecurring;
    let recurringMessage = '';
    if (isRecurring) {
      recurringMessage = '<p><strong>This is a recurring event and the update applies to all events in the series.</strong></p>';
    }

    // Per-field "(changed)" tags (plain amber): only the rows that actually changed are marked;
    // everything else stays as normal context. `changed` is absent for callers that don't pass it,
    // in which case no tags render.
    const changed = eventSnapshot.changed || {};
    const changedTag = (isChanged) => (isChanged ? ' <span style="color: #d97706; font-weight: 600;">(changed)</span>' : '');

    // Send email to each unique attendee
    for (const [email, attendee] of uniqueAttendees) {
      const html = `
        <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
          <h2 style="color: #f59e0b; margin-top: 0;">Event Update Notice</h2>
          
          <p>Dear ${attendee.firstName || 'Attendee'},</p>
          
          <p>The organizer has made some updates to the event <strong>"${eventSnapshot.title}"</strong>.<br/>
          Please check the website for the latest event information: <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a></p>
          ${recurringMessage}
          
          <!-- Header Table: Event Details -->
          <div style="margin-bottom: 20px;">
            <table style="border-collapse: collapse; border: 1px solid #d1d5db; border-radius: 8px; width: auto;">
              <tr>
                <td colspan="2" style="background-color: #f9fafb; padding: 15px; border-bottom: 1px solid #d1d5db; font-weight: bold;">Event Details</td>
              </tr>
              <tr>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Event Code</strong></td>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${eventSnapshot.eventCode}</td>
              </tr>
              <tr>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Event</strong></td>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${eventSnapshot.title}</td>
              </tr>
              <tr>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Date</strong></td>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${eventDateFormatted}${changedTag(changed.date)}</td>
              </tr>
              <tr>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Time</strong></td>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${eventTime} (${eventSnapshot.timeZone || 'Australia/Sydney'})${changedTag(changed.time)}</td>
              </tr>
              <tr>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Venue</strong></td>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${eventSnapshot.venue}${changedTag(changed.venue)}</td>
              </tr>
              ${eventSnapshot.address?.formattedAddress ? `
              <tr>
                <td style="padding: 12px;"><strong>Address</strong></td>
                <td style="padding: 12px;">${eventSnapshot.address.formattedAddress}${changedTag(changed.address)}</td>
              </tr>
              ` : ''}
            </table>
          </div>
          
          ${eventSnapshot.organizer ? `
          <!-- Header Table: Event Organizer Contact -->
          <div style="margin-bottom: 20px;">
            <table style="border-collapse: collapse; border: 1px solid #d1d5db; border-radius: 8px; width: auto;">
              <tr>
                <td colspan="2" style="background-color: #f9fafb; padding: 15px; border-bottom: 1px solid #d1d5db; font-weight: bold;">Event Organizer Contact</td>
              </tr>
              <tr>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Name</strong></td>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${eventSnapshot.organizer.name || 'N/A'}</td>
              </tr>
              ${eventSnapshot.organizer.email ? `
              <tr>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Email</strong></td>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><a href="mailto:${eventSnapshot.organizer.email}" style="color: #3b82f6;">${eventSnapshot.organizer.email}</a></td>
              </tr>
              ` : ''}
              ${eventSnapshot.organizer.phone || eventSnapshot.organizer.contact ? `
              <tr>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Phone</strong></td>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${eventSnapshot.organizer.phone || eventSnapshot.organizer.contact}</td>
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
          
          <p>For any questions about this event, please contact the organiser directly. The Desify Team does not manage event updates or cancellations.</p>

          <p>Thank you,<br/>
          — ${platformTeam}</p>
        </div>
      `;

      try {
        await sendEmail({
          to: email,
          from: { email: 'noreply@desify.com.au', name: platformName },
          subject: `${eventSnapshot.eventCode} - Event Update: ${eventSnapshot.title}`,
          html,
          category: 'events', // routes via EMAIL_PROVIDER_EVENTS (shared-email-provider-switch.md D3)
        });
        console.log(`✅ Update notification sent to ${email}`);
      } catch (error) {
        console.error(`❌ Failed to send update notification to ${email}:`, error.message);
      }
    }

    console.log(`✅ Event update notifications completed`);
  } catch (error) {
    console.error('❌ Error sending event update notifications:', error);
  }
};

/**
 * Send event deletion/cancellation notification to all ticket holders
 * Must be called BEFORE event is actually deleted
 * * - Schemas used: EventInvoice, FreeTicket
 * - Called from: eventController.js (deleteEvent) - line 758
 */
export const sendEventDeletionNotification = async (event, deletedBy = 'organizer') => {
  try {
    console.log(`📧 Preparing to send deletion notifications for event ${event._id} (${event.isPaid ? 'Paid' : 'Free'} event)`);
    console.log(`📧 Event title: ${event.title}, isPaid: ${event.isPaid}`);
    
    // Check if event has already passed - no point notifying about past events
    const eventDate = new Date(event.dateTime);
    const now = new Date();
    
    if (eventDate < now) {
      console.log(`📅 Event "${event.title}" has already passed (${eventDate.toISOString()}). Skipping attendee deletion notifications.`);
      return;
    }
    
    const uniqueAttendees = new Map();
    let eventSnapshot = event;

    // Handle PAID events - look for invoices
    if (event.isPaid) {
      const invoices = await EventInvoice.find({
        event: event._id,
        status: { $ne: 'cancelled' } // Don't send to cancelled invoices
      }).select('buyer.email buyer.firstName buyer.lastName eventSnapshot');

      if (invoices && invoices.length > 0) {
        // Use eventSnapshot from invoice or fallback to event object
        eventSnapshot = invoices[0]?.eventSnapshot || event;

        // Get unique buyer emails
        invoices.forEach(invoice => {
          if (invoice.buyer?.email) {
            uniqueAttendees.set(invoice.buyer.email, {
              email: invoice.buyer.email,
              firstName: invoice.buyer.firstName || '',
              lastName: invoice.buyer.lastName || ''
            });
          }
        });
      }
    } 
    // Handle FREE events - look for tickets
    else {
      const freeTickets = await FreeTicket.find({
        event: event._id,
        status: { $in: ['registered', 'checkedin'] } // Include both registered and checked-in attendees
      }).populate('user', 'name').select('user email eventSnapshot attendees');

      console.log(`📋 Found ${freeTickets.length} free tickets for event ${event._id}`);
      
      // Debug: Log the first ticket to see structure
      if (freeTickets.length > 0) {
        console.log(`🎫 Sample ticket:`, {
          email: freeTickets[0].email,
          attendees: freeTickets[0].attendees?.map(a => a.name),
          status: freeTickets[0].status
        });
      }

      if (freeTickets && freeTickets.length > 0) {
        // Use eventSnapshot from ticket or fallback to event object
        eventSnapshot = freeTickets[0]?.eventSnapshot || event;

        // Get unique attendee emails from the email field directly
        freeTickets.forEach(ticket => {
          if (ticket.email) {
            // Get the first name from the user if populated, otherwise use first attendee name
            let firstName = '';
            if (ticket.user?.name) {
              firstName = ticket.user.name.split(' ')[0];
            } else if (ticket.attendees && ticket.attendees.length > 0) {
              firstName = ticket.attendees[0].name.split(' ')[0];
            }
            
            uniqueAttendees.set(ticket.email, {
              email: ticket.email,
              firstName: firstName,
              lastName: ''
            });
            console.log(`✉️ Added email: ${ticket.email} (Name: ${firstName})`);
          }
        });
      }
    }

    if (uniqueAttendees.size === 0) {
      console.log('No attendees/buyers found for deletion notification');
      return;
    }

    console.log(`Found ${uniqueAttendees.size} unique ${event.isPaid ? 'buyers' : 'attendees'} to notify about deletion`);
    
    // Debug: Log all emails to be sent
    console.log(`📧 Emails to send:`, Array.from(uniqueAttendees.keys()));

    // Check if it's a recurring event
    const isRecurring = event.recurrence?.isRecurring;

    // Send email to each unique attendee/buyer
    for (const [email, attendee] of uniqueAttendees) {
      const html = `
        <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
          <h2 style="color: #dc2626; margin-top: 0;">Event Cancelled/Removed</h2>
          
          <p>Dear ${attendee.firstName || 'Attendee'},</p>
          
          <p>The event <strong>"${eventSnapshot.title}"</strong> has been ${deletedBy === 'admin' ? 'cancelled by Desify team due to moderation or event reported as abuse' : 'cancelled/removed by the organizer'}.</p>
          ${isRecurring ? '<p><strong>This is a recurring event and all events in the series will be cancelled.</strong></p>' : ''}
          
          ${eventSnapshot.organizer ? `
          <!-- Header Table: Event Organizer Contact -->
          <div style="margin-bottom: 20px;">
            <table style="border-collapse: collapse; border: 1px solid #d1d5db; border-radius: 8px; width: auto;">
              <tr>
                <td colspan="2" style="background-color: #f9fafb; padding: 15px; border-bottom: 1px solid #d1d5db; font-weight: bold;">Event Organizer Contact</td>
              </tr>
              <tr>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Name</strong></td>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${eventSnapshot.organizer.name || 'N/A'}</td>
              </tr>
              ${eventSnapshot.organizer.email ? `
              <tr>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Email</strong></td>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><a href="mailto:${eventSnapshot.organizer.email}" style="color: #3b82f6;">${eventSnapshot.organizer.email}</a></td>
              </tr>
              ` : ''}
              ${eventSnapshot.organizer.phone || eventSnapshot.organizer.contact ? `
              <tr>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;"><strong>Phone</strong></td>
                <td style="padding: 12px; border-bottom: 1px solid #d1d5db;">${eventSnapshot.organizer.phone || eventSnapshot.organizer.contact}</td>
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

          <p>For any questions about this event, please contact the organiser directly. The Desify Team does not manage event updates or cancellations.</p>

          <p>Thank you,<br/>
          — ${platformTeam}</p>
        </div>
      `;

      try {
        await sendEmail({
          to: email,
          from: { email: 'noreply@desify.com.au', name: platformName },
          subject: `${eventSnapshot.eventCode || event.eventCode} - Event Cancelled: ${eventSnapshot.title}`,
          html,
          category: 'events', // routes via EMAIL_PROVIDER_EVENTS (shared-email-provider-switch.md D3)
        });
        console.log(`✅ Deletion notification sent to ${email}`);
      } catch (error) {
        console.error(`❌ Failed to send deletion notification to ${email}:`, error.message);
      }
    }

    console.log(`✅ Event deletion notifications completed`);
  } catch (error) {
    console.error('❌ Error sending event deletion notifications:', error);
  }
};