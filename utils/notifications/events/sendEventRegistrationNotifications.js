/**
 * Last updated: 2025-12-08
 */

import { sendEmail } from '../sendEmail.js';
import { format } from 'date-fns';
import dateFnsTz from 'date-fns-tz';
import { generateSlug } from '../../helpers/shared/generateSlug.js';
const { formatInTimeZone } = dateFnsTz;

const websiteUrl = process.env.WEBSITE_URL;
const platformName = process.env.NOTIFICATION_PLATFORM_NAME || 'the website';
const platformTeam = process.env.NOTIFICATION_PLATFORM_TEAM || 'Desify Team';

// Helper function to create responsive table rows
const createTableRow = (label, value) => {
  return `
    <tr>
      <td style="padding: 8px; border: 1px solid #e5e7eb; background-color: #f9fafb; font-weight: 600; text-align: left; width: 40%;">${label}</td>
      <td style="padding: 8px; border: 1px solid #e5e7eb; text-align: left;">${value || 'N/A'}</td>
    </tr>
  `;
};

/**
 * sendRegistrationConfirmationToAttendee
 * - Schemas used: FreeTicket
 * - Called from: freeEventController.js (registerForFreeEvent)
 * - Purpose: Sends registration confirmation email to attendee
 */
export const sendRegistrationConfirmationToAttendee = async ({ registration, event }) => {
  if (!registration?.email) return;

  const eventDateTime = new Date(event.dateTime || registration.eventSnapshot.dateTime);
  const eventTimeZone = event.timeZone || registration.eventSnapshot.timeZone || 'Australia/Sydney';
  
  const eventDate = formatInTimeZone(eventDateTime, eventTimeZone, 'EEEE, dd MMMM yyyy');
  const eventTime = formatInTimeZone(eventDateTime, eventTimeZone, 'h:mm a');
  const eventDateShort = formatInTimeZone(eventDateTime, eventTimeZone, 'dd/MM/yyyy');

  const eventCode = event.eventCode || registration.eventSnapshot.eventCode;
  const eventTitle = event.title || registration.eventSnapshot.title;
  const venue = event.venue || registration.eventSnapshot.venue;
  const address = event.address || registration.eventSnapshot.address;
  
  // Check if event is recurring
  const isRecurring = event.recurrence?.isRecurring || registration.eventSnapshot.recurrence?.isRecurring;
  
  // Get attendee names
  const attendeesList = registration.attendees
    .map((attendee, index) => `${index + 1}. ${attendee.name}`)
    .join('<br/>');
    
  // Get form responses
  const formResponsesHtml = registration.formResponses && registration.formResponses.length > 0
    ? registration.formResponses.map(response => 
        createTableRow(response.fieldName, response.response)
      ).join('')
    : '';

  // Get registered by name
  const registeredBy = registration.user?.name || 'User';

  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
      <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
        <h2 style="color: #0d9488; margin-top: 0;">Registration Confirmed (${registration.registrationNumber})!</h2>
        <p style="font-size: 16px; margin-bottom: 0;">Your registration for <strong>"${eventTitle}"</strong> has been confirmed.</p>
      </div>
      
      <!-- Event Details Table -->
      <div style="margin-bottom: 20px;">
        <h3 style="color: #374151; margin-bottom: 10px;">Event Details</h3>
        <table style="width: 100%; border-collapse: collapse; background-color: #ffffff;">
          ${createTableRow('Event Code', eventCode)}
          ${createTableRow('Title', eventTitle)}
          ${createTableRow('Event Date', eventDate)}
          ${createTableRow('Event Time / TimeZone', `${eventTime} (${eventTimeZone})`)}
          ${createTableRow('Venue / Location', venue)}
          ${address?.formattedAddress ? createTableRow('Address', address.formattedAddress) : ''}
        </table>
        ${isRecurring ? '<p style="margin-top: 10px; color: #dc2626; font-weight: 600;">This event is part of a recurring event series.</p>' : ''}
      </div>
      
      <!-- Registration Details Table -->
      <div style="margin-bottom: 20px;">
        <h3 style="color: #374151; margin-bottom: 10px;">Registration Details</h3>
        <table style="width: 100%; border-collapse: collapse; background-color: #ffffff;">
          ${createTableRow('Registration Number', registration.registrationNumber)}
          ${createTableRow('Registered By', registeredBy)}
          ${createTableRow('Email', registration.email)}
          ${createTableRow('Mobile', registration.mobile || 'Not provided')}
          ${createTableRow('Number of Attendees', registration.attendees.length)}
          ${createTableRow('Attendee Names', attendeesList)}
          ${formResponsesHtml ? `<tr><td colspan="2" style="padding: 8px; border: 1px solid #e5e7eb; background-color: #f9fafb; font-weight: 600;">Attendee Information</td></tr>${formResponsesHtml}` : ''}
        </table>
      </div>
      
      <!-- Organizer Details Table -->
      ${event.organizer || registration.eventSnapshot.organizer ? `
      <div style="margin-bottom: 20px;">
        <h3 style="color: #374151; margin-bottom: 10px;">Organizer Details</h3>
        <table style="width: 100%; border-collapse: collapse; background-color: #ffffff;">
          ${createTableRow('Name', event.organizer?.name || registration.eventSnapshot.organizer?.name)}
          ${createTableRow('Email', event.organizer?.email || registration.eventSnapshot.organizer?.email)}
          ${createTableRow('Phone', event.organizer?.phone || registration.eventSnapshot.organizer?.phone)}
          ${event.organizer?.website || registration.eventSnapshot.organizer?.website ? 
            createTableRow('Website', `<a href="${event.organizer?.website || registration.eventSnapshot.organizer?.website}" style="color: #3b82f6;">${event.organizer?.website || registration.eventSnapshot.organizer?.website}</a>`) : ''}
        </table>
      </div>
      ` : ''}
      
      <div style="margin-bottom: 20px;">
        <h3 style="color: #374151; margin-bottom: 10px;">Registered users</h3>
        <p>View your event details and registrations at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a></p>
        <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Event Details</strong> : <a href="${websiteUrl}/events/${generateSlug(eventTitle)}-${registration.event?._id || registration.event}" style="color: #3b82f6;">${eventTitle}</a></p>
        <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>View RSVPs</strong> : Profile > Events [attendee] > My RSVPs</p>
      </div>

      <p>Thank you,<br/>
      — ${platformTeam}</p>
    </div>
  `;

  try {
    await sendEmail({
      to: registration.email,
      from: { email: 'noreply@desify.com.au', name: platformName },
      subject: `${eventCode} - "${eventTitle}" - ${eventDateShort} - Registration Confirmed`,
      html,
      category: 'events', // routes via EMAIL_PROVIDER_EVENTS (shared-email-provider-switch.md D3)
    });
    
    // Update confirmationSentAt timestamp
    if (registration._id) {
      const FreeTicket = (await import('../../../models/freeTicket.js')).default;
      await FreeTicket.findByIdAndUpdate(registration._id, {
        confirmationSentAt: new Date()
      });
    }

    console.log(`✅ Registration confirmation sent to ${registration.email}`);
  } catch (error) {
    console.error(`❌ Failed to send registration confirmation: ${error.message}`);
    throw error;
  }
};

/**
 * sendRegistrationNotificationToOrganizer
 * - Schemas used: None (uses passed data)
 * - Called from: freeEventController.js (registerForFreeEvent)
 * - Purpose: Notifies event organizer about new registration
 */
export const sendRegistrationNotificationToOrganizer = async ({ registration, event, organizerEmail }) => {
  if (!organizerEmail) return;

  const eventDateTime = new Date(event.dateTime || registration.eventSnapshot.dateTime);
  const eventTimeZone = event.timeZone || registration.eventSnapshot.timeZone || 'Australia/Sydney';
  
  const eventDate = formatInTimeZone(eventDateTime, eventTimeZone, 'EEEE, dd MMMM yyyy');
  const eventTime = formatInTimeZone(eventDateTime, eventTimeZone, 'h:mm a');
  const eventDateShort = formatInTimeZone(eventDateTime, eventTimeZone, 'dd/MM/yyyy');

  const eventCode = event.eventCode || registration.eventSnapshot.eventCode;
  const eventTitle = event.title || registration.eventSnapshot.title;
  const venue = event.venue || registration.eventSnapshot.venue;
  const address = event.address || registration.eventSnapshot.address;
  
  // Check if event is recurring
  const isRecurring = event.recurrence?.isRecurring || registration.eventSnapshot.recurrence?.isRecurring;
  
  const attendeeCount = registration.attendees.length;
  const attendeesList = registration.attendees
    .map((attendee, index) => `${index + 1}. ${attendee.name}`)
    .join('<br/>');

  // Get user info if available
  const registeredBy = registration.user?.name || 'User';
  const registeredByEmail = registration.email;
  
  // Get form responses
  const formResponsesHtml = registration.formResponses && registration.formResponses.length > 0
    ? registration.formResponses.map(response => 
        createTableRow(response.fieldName, response.response)
      ).join('')
    : '';

  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
      <div style="background-color: #f0fdf4; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
        <h2 style="color: #16a34a; margin-top: 0;">New Registration for Your Event!</h2>
        <p style="font-size: 16px; margin-bottom: 0;">Someone has registered for <strong>"${eventTitle}"</strong>.</p>
      </div>
      
      <!-- Event Details Table -->
      <div style="margin-bottom: 20px;">
        <h3 style="color: #374151; margin-bottom: 10px;">Event Details</h3>
        <table style="width: 100%; border-collapse: collapse; background-color: #ffffff;">
          ${createTableRow('Event Code', eventCode)}
          ${createTableRow('Title', eventTitle)}
          ${createTableRow('Event Date', eventDate)}
          ${createTableRow('Event Time / TimeZone', `${eventTime} (${eventTimeZone})`)}
          ${createTableRow('Venue / Location', venue)}
          ${address?.formattedAddress ? createTableRow('Address', address.formattedAddress) : ''}
        </table>
        ${isRecurring ? '<p style="margin-top: 10px; color: #dc2626; font-weight: 600;">This event is part of a recurring event series.</p>' : ''}
      </div>
      
      <!-- Registration Details Table -->
      <div style="margin-bottom: 20px;">
        <h3 style="color: #374151; margin-bottom: 10px;">Registration Details</h3>
        <table style="width: 100%; border-collapse: collapse; background-color: #ffffff;">
          ${createTableRow('Registration Number', registration.registrationNumber)}
          ${createTableRow('Registered By', registeredBy)}
          ${createTableRow('Email', registeredByEmail)}
          ${createTableRow('Mobile', registration.mobile || 'Not provided')}
          ${createTableRow('Number of Attendees', attendeeCount)}
          ${createTableRow('Attendee Names', attendeesList)}
          ${formResponsesHtml ? `<tr><td colspan="2" style="padding: 8px; border: 1px solid #e5e7eb; background-color: #f9fafb; font-weight: 600;">Attendee Information</td></tr>${formResponsesHtml}` : ''}
        </table>
      </div>
      
      <p>Manage your events from the User Profile at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a></p>
      <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Manage</strong> : Profile > Events [Host] > RSVP Event > Manage</p>
      <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Check-in</strong> : Profile > Events [Host] > RSVP Event > Check-in</p>

      <p>Thank you,<br/>
      — ${platformTeam}</p>
    </div>
  `;

  try {
    await sendEmail({
      to: organizerEmail,
      subject: `${eventCode} - "${eventTitle}" - ${eventDateShort} - New Registration`,
      html,
      category: 'events', // routes via EMAIL_PROVIDER_EVENTS (shared-email-provider-switch.md D3)
    });

    console.log(`✅ Registration notification sent to organizer ${organizerEmail}`);
  } catch (error) {
    console.error(`❌ Failed to send organizer notification: ${error.message}`);
    // Don't throw error for organizer email - it's not critical
  }
};

/**
 * sendCancellationConfirmation
 * - Schemas used: None (uses passed data)
 * - Called from: freeEventController.js (unregisterFromFreeEvent)
 * - Purpose: Sends cancellation confirmation to both attendee and organizer
 */
export const sendCancellationConfirmation = async ({ registration, event, attendeeEmail, organizerEmail }) => {
  const eventTitle = event?.title || registration.eventSnapshot.title;
  const eventCode = event?.eventCode || registration.eventSnapshot.eventCode;
  const venue = event?.venue || registration.eventSnapshot.venue;
  const eventDateTime = new Date(event?.dateTime || registration.eventSnapshot.dateTime);
  const eventTimeZone = event?.timeZone || registration.eventSnapshot.timeZone || 'Australia/Sydney';
  const eventDateShort = formatInTimeZone(eventDateTime, eventTimeZone, 'dd/MM/yyyy');

  // Get additional details for tables
  const eventDate = formatInTimeZone(eventDateTime, eventTimeZone, 'EEEE, dd MMMM yyyy');
  const eventTime = formatInTimeZone(eventDateTime, eventTimeZone, 'h:mm a');
  const isRecurring = event?.recurrence?.isRecurring || registration.eventSnapshot.recurrence?.isRecurring;
  const address = event?.address || registration.eventSnapshot.address;
  
  // Get attendee names
  const attendeesList = registration.attendees
    .map((attendee, index) => `${index + 1}. ${attendee.name}`)
    .join('<br/>');
    
  // Get registered by name
  const registeredBy = registration.user?.name || 'User';

  // Email to attendee
  if (attendeeEmail || registration.email) {
    const attendeeHtml = `
      <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
        <div style="background-color: #fee2e2; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
          <h2 style="color: #dc2626; margin-top: 0;">Registration Cancelled</h2>
          <p style="font-size: 16px; margin-bottom: 0;">Your registration for <strong>"${eventTitle}"</strong> has been cancelled.</p>
        </div>
        
        <!-- Event Details Table -->
        <div style="margin-bottom: 20px;">
          <h3 style="color: #374151; margin-bottom: 10px;">Event Details</h3>
          <table style="width: 100%; border-collapse: collapse; background-color: #ffffff;">
            ${createTableRow('Event Code', eventCode)}
            ${createTableRow('Title', eventTitle)}
            ${createTableRow('Event Date', eventDate)}
            ${createTableRow('Event Time / TimeZone', `${eventTime} (${eventTimeZone})`)}
            ${createTableRow('Venue / Location', venue)}
            ${address?.formattedAddress ? createTableRow('Address', address.formattedAddress) : ''}
          </table>
          ${isRecurring ? '<p style="margin-top: 10px; color: #dc2626; font-weight: 600;">This event is part of a recurring event series.</p>' : ''}
        </div>
        
        <!-- Cancelled Registration Details -->
        <div style="margin-bottom: 20px;">
          <h3 style="color: #374151; margin-bottom: 10px;">Cancelled Registration Details</h3>
          <table style="width: 100%; border-collapse: collapse; background-color: #ffffff;">
            ${createTableRow('Registration Number', registration.registrationNumber)}
            ${createTableRow('Number of Attendees', registration.attendees.length)}
            ${createTableRow('Attendee Names', attendeesList)}
          </table>
        </div>
        
        <p>If this was a mistake, you can register again for <a href="${websiteUrl}/events/${generateSlug(eventTitle)}-${event?._id || registration.event}" style="color: #3b82f6;">"${eventTitle}"</a></p>

        <p>Thank you,<br/>
        — ${platformTeam}</p>
      </div>
    `;

    try {
      await sendEmail({
        to: attendeeEmail || registration.email,
        from: { email: 'noreply@desify.com.au', name: platformName },
        subject: `${eventCode} - "${eventTitle}" - ${eventDateShort} - Registration Cancelled`,
        html: attendeeHtml,
        category: 'events', // routes via EMAIL_PROVIDER_EVENTS (shared-email-provider-switch.md D3)
      });
    } catch (error) {
      console.error(`❌ Failed to send cancellation email to attendee: ${error.message}`);
    }
  }

  // Email to organizer
  if (organizerEmail) {
    const organizerHtml = `
      <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">
        <div style="background-color: #fee2e2; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
          <h2 style="color: #dc2626; margin-top: 0;">Registration Cancelled</h2>
          <p style="font-size: 16px; margin-bottom: 0;">A registration for your event <strong>"${eventTitle}"</strong> has been cancelled.</p>
        </div>
        
        <!-- Event Details Table -->
        <div style="margin-bottom: 20px;">
          <h3 style="color: #374151; margin-bottom: 10px;">Event Details</h3>
          <table style="width: 100%; border-collapse: collapse; background-color: #ffffff;">
            ${createTableRow('Event Code', eventCode)}
            ${createTableRow('Title', eventTitle)}
            ${createTableRow('Event Date', eventDate)}
            ${createTableRow('Event Time / TimeZone', `${eventTime} (${eventTimeZone})`)}
            ${createTableRow('Venue / Location', venue)}
            ${address?.formattedAddress ? createTableRow('Address', address.formattedAddress) : ''}
          </table>
          ${isRecurring ? '<p style="margin-top: 10px; color: #dc2626; font-weight: 600;">This event is part of a recurring event series.</p>' : ''}
        </div>
        
        <!-- Cancelled Registration Details -->
        <div style="margin-bottom: 20px;">
          <h3 style="color: #374151; margin-bottom: 10px;">Cancelled Registration Details</h3>
          <table style="width: 100%; border-collapse: collapse; background-color: #ffffff;">
            ${createTableRow('Registration Number', registration.registrationNumber)}
            ${createTableRow('Registered By', registeredBy)}
            ${createTableRow('Email', registration.email)}
            ${createTableRow('Mobile', registration.mobile || 'Not provided')}
            ${createTableRow('Number of Attendees', registration.attendees.length)}
            ${createTableRow('Attendee Names', attendeesList)}
          </table>
        </div>
        
        <p>Manage your events from the User Profile at <a href="${websiteUrl}" style="color: #3b82f6;">${websiteUrl}</a></p>
        <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Manage</strong> : Profile > Events [Host] > RSVP Event > Manage</p>
        <p style="margin: 5px 0 5px 20px; font-size: 13px;"><strong>Check-in</strong> : Profile > Events [Host] > RSVP Event > Check-in</p>

        <p>Thank you,<br/>
        — ${platformTeam}</p>
      </div>
    `;

    try {
      await sendEmail({
        to: organizerEmail,
        subject: `${eventCode} - "${eventTitle}" - ${eventDateShort} - Registration Cancelled`,
        html: organizerHtml,
        category: 'events', // routes via EMAIL_PROVIDER_EVENTS (shared-email-provider-switch.md D3)
      });
    } catch (error) {
      console.error(`❌ Failed to send cancellation email to organizer: ${error.message}`);
    }
  }
};