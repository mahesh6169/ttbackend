import fetch from 'node-fetch';

/**
 * Send email using MailerSend API (no tracking pixels by default)
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML content
 * @param {string} options.text - Plain text content (optional)
 * @param {string} options.from - From address (optional, uses default if not provided)
 */
export const sendEmailWithMailerSend = async (options, { fetchImpl = fetch } = {}) => {
  const apiKey = process.env.MAILERSEND_API_KEY;
  const defaultFrom = {
    email: process.env.SENDER_EMAIL,
    name: process.env.NOTIFICATION_PLATFORM_NAME || 'Desify'
  };

  const emailData = {
    from: options.from || defaultFrom,
    to: [{ email: options.to }],
    subject: options.subject,
    html: options.html,
    text: options.text || stripHtml(options.html),
    // Disable tracking
    settings: {
      track_clicks: false,
      track_opens: false,
      track_content: false
    }
  };

  // Add attachments if provided
  if (options.attachments && options.attachments.length > 0) {
    emailData.attachments = options.attachments;
  }

  try {
    const response = await fetchImpl('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(emailData)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`MailerSend API error: ${response.status} - ${error}`);
    }

    // MailerSend returns 202 Accepted with empty body on success
    if (response.status === 202) {
      console.log('✅ Email sent successfully via MailerSend (202 Accepted)');
      return { success: true, status: 202 };
    }

    // For other success codes, try to parse JSON
    const text = await response.text();
    const result = text ? JSON.parse(text) : { success: true };
    console.log('✅ Email sent successfully via MailerSend:', result);
    return result;
  } catch (error) {
    console.error('❌ MailerSend email failed:', error);
    throw error;
  }
};

/**
 * Simple HTML to text converter
 */
const stripHtml = (html) => {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
};

// Normalized send() mirroring the Mailjet adapter's signature (featureplans/shared-email-provider-switch.md
// D8), so the router can dispatch to either provider the same way. Delegates to the existing
// sendEmailWithMailerSend - behaviour is unchanged (a 202 response is a success).
export const send = (options, deps) => sendEmailWithMailerSend(options, deps);

export default sendEmailWithMailerSend;