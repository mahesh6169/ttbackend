// utils/notifications/mailjet.js
//
// Mailjet Send API v3.1 adapter (featureplans/shared-email-provider-switch.md D7). Second email
// provider behind the sendEmail() router. Basic auth (MAILJET_API_KEY : MAILJET_SECRET_KEY); reuses
// node-fetch (no new dependency, D6). Translates our internal options {to, subject, html, text?,
// from?, attachments?} into the Mailjet Messages[] shape, splitting inline attachments (disposition
// 'inline' + an id) into InlinedAttachments and the rest into Attachments. Resolves ONLY when
// Messages[0].Status === 'success'; any other status (or a non-2xx response) throws - so a failure
// means "not accepted", which lets the router fall back to the other provider with no double-send.
// fetchImpl / env are injectable so tests exercise the translation + status handling with no network.

import fetch from 'node-fetch';

const stripHtml = (html) =>
  (html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

export const send = async (options, { fetchImpl = fetch, env = process.env } = {}) => {
  const auth = Buffer.from(`${env.MAILJET_API_KEY}:${env.MAILJET_SECRET_KEY}`).toString('base64');

  const platformName = env.NOTIFICATION_PLATFORM_NAME || 'Desify';
  const from = options.from
    ? { Email: options.from.email || options.from, Name: options.from.name || platformName }
    : { Email: env.SENDER_EMAIL, Name: platformName };

  // Split our internal attachment shape ({ content(base64), filename, disposition, id, type? }) into
  // Mailjet's InlinedAttachments (inline, needs a ContentID) vs plain Attachments.
  const inlinedAttachments = [];
  const attachments = [];
  for (const a of options.attachments || []) {
    const mapped = {
      ContentType: a.type || a.content_type || 'application/octet-stream',
      Filename: a.filename,
      Base64Content: a.content,
    };
    if (a.disposition === 'inline' && a.id) inlinedAttachments.push({ ...mapped, ContentID: a.id });
    else attachments.push(mapped);
  }

  const message = {
    From: from,
    To: [{ Email: options.to }],
    Subject: options.subject,
    HTMLPart: options.html,
    TextPart: options.text || stripHtml(options.html),
  };
  if (inlinedAttachments.length) message.InlinedAttachments = inlinedAttachments;
  if (attachments.length) message.Attachments = attachments;

  const response = await fetchImpl('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Messages: [message] }),
  });

  if (!response.ok) {
    let body = '';
    try { body = await response.text(); } catch (e) { /* ignore */ }
    throw new Error(`Mailjet API error: ${response.status} - ${body}`);
  }

  const result = await response.json();
  const status = result?.Messages?.[0]?.Status;
  if (status !== 'success') {
    throw new Error(`Mailjet did not accept the message (status: ${status || 'unknown'})`);
  }
  return { success: true, provider: 'mailjet', status, result };
};

export default send;
