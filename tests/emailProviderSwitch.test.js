// Rules for featureplans/shared-email-provider-switch.md (AC1-AC11). The provider switch is additive
// and ships OFF; these tests exercise the selection chain, the fallback rule (no double-send), the
// preserved test-capture branch, and the two provider adapters - all with injected providers / a fake
// fetch, so nothing hits the network (real delivery is the owner's manual check, AC12).
import { selectProvider, routeEmail, sendEmail, getCapturedEmails, clearCapturedEmails } from '../utils/notifications/sendEmail.js';
import { send as mailjetSend } from '../utils/notifications/mailjet.js';
import { send as mailersendSend } from '../utils/notifications/mailersend.js';
import { sendWelcomeEmail, sendVerifyOtpEmail, sendResetOtpEmail, sendAccountDeletionEmail } from '../utils/notifications/users/newUserNotifications.js';
import { sendTicketPurchaseConfirmationToBuyer } from '../utils/notifications/events/sendPaidTicketNotifications.js';

const mjEnv = { MAILJET_API_KEY: 'k', MAILJET_SECRET_KEY: 's', SENDER_EMAIL: 'from@desify.test', NOTIFICATION_PLATFORM_NAME: 'Desify' };

// Tiny spy (this pure-ESM Jest setup does not inject the `jest` global): records calls, runs impl.
const makeSpy = (impl) => {
  const fn = async (...args) => { fn.calls.push(args); return impl(...args); };
  fn.calls = [];
  return fn;
};

test('AC1 category signin selects EMAIL_PROVIDER_SIGNIN, then EMAIL_PROVIDER_DEFAULT, then mailersend', () => {
  expect(selectProvider('signin', { EMAIL_PROVIDER_SIGNIN: 'mailjet' })).toBe('mailjet');
  expect(selectProvider('signin', { EMAIL_PROVIDER_DEFAULT: 'mailjet' })).toBe('mailjet');
  expect(selectProvider('signin', {})).toBe('mailersend');
});

test('AC2 no category uses EMAIL_PROVIDER_DEFAULT (or mailersend when unset)', () => {
  expect(selectProvider(undefined, { EMAIL_PROVIDER_DEFAULT: 'mailjet' })).toBe('mailjet');
  expect(selectProvider(undefined, {})).toBe('mailersend');
});

test('AC3 with fallback ON, a throwing primary falls back to the other provider and resolves', async () => {
  const mailersend = makeSpy(async () => { throw new Error('primary down'); });
  const mailjet = makeSpy(async () => ({ ok: true, via: 'mailjet' }));
  const res = await routeEmail(
    { to: 'a@b.c', category: 'signin' },
    { env: { EMAIL_PROVIDER_SIGNIN: 'mailersend', EMAIL_FALLBACK_ENABLED: 'true' }, providers: { mailersend, mailjet } }
  );
  expect(mailersend.calls.length).toBe(1);
  expect(mailjet.calls.length).toBe(1);
  expect(res).toEqual({ ok: true, via: 'mailjet' });
});

test('AC4 with fallback OFF, a throwing primary propagates and the other provider is NOT called', async () => {
  const mailersend = makeSpy(async () => { throw new Error('primary down'); });
  const mailjet = makeSpy(async () => ({ ok: true }));
  await expect(
    routeEmail({ to: 'a@b.c' }, { env: { EMAIL_FALLBACK_ENABLED: 'false' }, providers: { mailersend, mailjet } })
  ).rejects.toThrow('primary down');
  expect(mailjet.calls.length).toBe(0);
});

test('AC5 when the primary resolves, the fallback provider is never called (no double-send)', async () => {
  const mailersend = makeSpy(async () => ({ ok: true }));
  const mailjet = makeSpy(async () => ({ ok: true }));
  await routeEmail({ to: 'a@b.c' }, { env: { EMAIL_FALLBACK_ENABLED: 'true' }, providers: { mailersend, mailjet } });
  expect(mailersend.calls.length).toBe(1);
  expect(mailjet.calls.length).toBe(0);
});

test('AC6 in NODE_ENV=test, sendEmail captures {to, subject, html} and calls no provider', async () => {
  clearCapturedEmails();
  const res = await sendEmail({ to: 'x@y.z', subject: 'Subj', html: '<p>h</p>', category: 'signin' });
  expect(res).toEqual({ captured: true });
  const caps = getCapturedEmails();
  expect(caps[caps.length - 1]).toMatchObject({ to: 'x@y.z', subject: 'Subj', html: '<p>h</p>' });
});

test('AC7 the Mailjet adapter resolves only when Messages[0].Status===success; else throws', async () => {
  const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ Messages: [{ Status: 'success' }] }) });
  await expect(mailjetSend({ to: 'a@b.c', subject: 's', html: '<p>h</p>' }, { fetchImpl: okFetch, env: mjEnv }))
    .resolves.toMatchObject({ success: true });

  const badStatus = async () => ({ ok: true, status: 200, json: async () => ({ Messages: [{ Status: 'error' }] }) });
  await expect(mailjetSend({ to: 'a@b.c', subject: 's', html: 'h' }, { fetchImpl: badStatus, env: mjEnv })).rejects.toThrow();

  const non2xx = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await expect(mailjetSend({ to: 'a@b.c', subject: 's', html: 'h' }, { fetchImpl: non2xx, env: mjEnv })).rejects.toThrow(/500/);
});

test('AC8 the Mailjet adapter maps our fields and routes inline vs regular attachments', async () => {
  let body;
  const capFetch = async (url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ Messages: [{ Status: 'success' }] }) };
  };
  await mailjetSend(
    {
      to: 'a@b.c', subject: 'Subj', html: '<p>Hi</p>', text: 'Hi', from: { email: 'me@x.co', name: 'Me' },
      attachments: [
        { content: 'AAA', filename: 'logo.png', disposition: 'inline', id: 'logo', type: 'image/png' },
        { content: 'BBB', filename: 'ticket.pdf', type: 'application/pdf' },
      ],
    },
    { fetchImpl: capFetch, env: mjEnv }
  );
  const m = body.Messages[0];
  expect(m.From).toEqual({ Email: 'me@x.co', Name: 'Me' });
  expect(m.To).toEqual([{ Email: 'a@b.c' }]);
  expect(m.Subject).toBe('Subj');
  expect(m.HTMLPart).toBe('<p>Hi</p>');
  expect(m.TextPart).toBe('Hi');
  expect(m.InlinedAttachments).toEqual([{ ContentType: 'image/png', Filename: 'logo.png', Base64Content: 'AAA', ContentID: 'logo' }]);
  expect(m.Attachments).toEqual([{ ContentType: 'application/pdf', Filename: 'ticket.pdf', Base64Content: 'BBB' }]);
});

test('AC9 the normalized MailerSend send() accepts our options and a 202 is a success', async () => {
  let body;
  const msFetch = async (url, opts) => { body = JSON.parse(opts.body); return { ok: true, status: 202, text: async () => '' }; };
  const res = await mailersendSend({ to: 'a@b.c', subject: 's', html: '<p>h</p>', text: 'h' }, { fetchImpl: msFetch });
  expect(res).toMatchObject({ success: true, status: 202 });
  expect(body.to).toEqual([{ email: 'a@b.c' }]);
  expect(body.subject).toBe('s');
});

test('AC10 all four account/auth emails (welcome, verify, reset, deletion) send category signin', async () => {
  clearCapturedEmails();
  await sendWelcomeEmail({ name: 'A', email: 'w@x.co' });
  await sendVerifyOtpEmail({ email: 'v@x.co', name: 'A', otp: '123456' });
  await sendResetOtpEmail({ email: 'r@x.co', name: 'A', otp: '123456' });
  await sendAccountDeletionEmail({ name: 'A', email: 'd@x.co' });
  const caps = getCapturedEmails();
  const byTo = (to) => caps.find((c) => c.to === to);
  expect(byTo('w@x.co').category).toBe('signin');
  expect(byTo('v@x.co').category).toBe('signin');
  expect(byTo('r@x.co').category).toBe('signin');
  expect(byTo('d@x.co').category).toBe('signin');
});

test('AC12 event mail carries category events (paid-ticket buyer email, the QR/attachment path)', async () => {
  clearCapturedEmails();
  const event = {
    title: 'Pack Fest', dateTime: new Date('2027-01-01T10:00:00Z'), timeZone: 'Australia/Sydney',
    venue: 'Test Hall', address: '1 Test St', gstIncluded: false,
    organizer: { name: 'Org', email: 'org@test.dev' }, ticketTypes: [{ name: 'General' }],
  };
  const tickets = [{
    ticketNumber: 'TKT-EVT-0001', event: 'evt1', ticketType: { name: 'General' },
    priceDetails: { totalPrice: 20 }, seats: [],
  }];
  const invoice = {
    invoiceNumber: 'INV-EVT-0001', buyer: { firstName: 'Bella', lastName: 'Buyer', email: 'buyer@test.dev' },
    amounts: { total: 20, subtotal: 20 },
  };
  await sendTicketPurchaseConfirmationToBuyer({ invoice, tickets, event });
  const mail = getCapturedEmails().find((m) => m.to === 'buyer@test.dev');
  expect(mail).toBeTruthy();
  expect(mail.category).toBe('events');
});

test('AC11 ship-off default: nothing set + fallback off -> every email resolves through mailersend', async () => {
  const mailersend = makeSpy(async () => ({ ok: true }));
  const mailjet = makeSpy(async () => ({ ok: true }));
  await routeEmail({ to: 'a@b.c', category: 'signin' }, { env: {}, providers: { mailersend, mailjet } });
  await routeEmail({ to: 'a@b.c' }, { env: {}, providers: { mailersend, mailjet } });
  expect(mailersend.calls.length).toBe(2);
  expect(mailjet.calls.length).toBe(0);
});
