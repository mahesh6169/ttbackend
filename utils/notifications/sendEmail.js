// utils/notifications/sendEmail.js
//
// The single choke point every backend email goes through. It selects an email provider per message
// and falls back to the other provider on a send failure (featureplans/shared-email-provider-switch.md).
// Ships OFF: with no EMAIL_PROVIDER_* set and fallback off it resolves through MailerSend exactly as
// before, so deploying changes nothing live; going live is an env-only flip.

import { send as mailersendSend } from './mailersend.js';
import { send as mailjetSend } from './mailjet.js';

// In-memory email capture for automated tests. When NODE_ENV=test, every send is diverted into this
// array INSTEAD of calling any provider, so tests assert on email content and nothing is ever sent.
// (category is also recorded so the pilot tagging is observable; existing suites read to/subject/html
// and are unaffected.)
const capturedEmails = [];
export const getCapturedEmails = () => capturedEmails;
export const clearCapturedEmails = () => { capturedEmails.length = 0; };

// The default provider registry. Injectable in routeEmail() so the selection + fallback logic can be
// tested with spies and no real network.
export const defaultProviders = { mailersend: mailersendSend, mailjet: mailjetSend };

// Pure provider selection (D2 chain): options.category -> EMAIL_PROVIDER_<CATEGORY> ->
// EMAIL_PROVIDER_DEFAULT -> 'mailersend'.
export const selectProvider = (category, env = process.env) => {
  const byCategory = category ? env[`EMAIL_PROVIDER_${String(category).toUpperCase()}`] : undefined;
  return byCategory || env.EMAIL_PROVIDER_DEFAULT || 'mailersend';
};

// Route one email to its provider, with automatic fallback to the OTHER provider only when the
// primary throws (which by design means "not accepted", so there is no double-send) and only when
// EMAIL_FALLBACK_ENABLED === 'true'. env + providers are injectable for tests.
export const routeEmail = async (options, { env = process.env, providers = defaultProviders } = {}) => {
  const primaryName = selectProvider(options.category, env);
  const primary = providers[primaryName] || providers.mailersend;

  try {
    return await primary(options);
  } catch (error) {
    if (env.EMAIL_FALLBACK_ENABLED === 'true') {
      const otherName = primaryName === 'mailersend' ? 'mailjet' : 'mailersend';
      const other = providers[otherName];
      if (other && other !== primary) {
        console.error(`Email primary (${primaryName}) failed; falling back to ${otherName}:`, error?.message);
        return await other(options);
      }
    }
    console.error('❌ Email sending failed:', error);
    throw error;
  }
};

/**
 * Send email through the provider router (or capture in test mode).
 * @param {Object} options - { to, subject, html, text?, from?, attachments?, category? }
 */
export const sendEmail = async (options) => {
  // Test mode: capture instead of send. Nothing leaves the process. This branch stays FIRST.
  if (process.env.NODE_ENV === 'test') {
    capturedEmails.push({ to: options.to, subject: options.subject, html: options.html, category: options.category });
    return { captured: true };
  }
  return routeEmail(options);
};

/**
 * Simple HTML to text converter for emails
 * @param {string} html - HTML content
 * @returns {string} Plain text version
 */
const generateTextFromHtml = (html) => {
  return html
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .replace(/&nbsp;/g, ' ') // Replace nbsp
    .replace(/&amp;/g, '&')  // Replace amp
    .replace(/&lt;/g, '<')   // Replace lt
    .replace(/&gt;/g, '>')   // Replace gt
    .replace(/\s+/g, ' ')    // Multiple spaces to single
    .trim();
};

export default sendEmail;
