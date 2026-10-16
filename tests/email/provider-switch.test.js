// Email provider switch - see featureplans/shared-email-provider-switch.md. The switch is additive
// and ships OFF; these tests exercise the selection chain, the fallback rule (no double-send), the
// test-mode capture branch, and the two provider adapters - all with injected providers or a fake
// fetch, so nothing hits the network (real delivery is the owner's manual check).
import { selectProvider, routeEmail, sendEmail } from '../../utils/notifications/sendEmail.js';
import { send as mailjetSend } from '../../utils/notifications/mailjet.js';
import { send as mailersendSend } from '../../utils/notifications/mailersend.js';
import { sendWelcomeEmail, sendVerifyOtpEmail, sendResetOtpEmail, sendAccountDeletionEmail } from '../../utils/notifications/users/newUserNotifications.js';
import { sendTicketPurchaseConfirmationToBuyer } from '../../utils/notifications/events/sendPaidTicketNotifications.js';
import { clearEmailsBeforeEach, getCapturedEmails } from '../helpers/email.js';

clearEmailsBeforeEach();

const mjEnv = { MAILJET_API_KEY: 'k', MAILJET_SECRET_KEY: 's', SENDER_EMAIL: 'from@desify.test', NOTIFICATION_PLATFORM_NAME: 'Desify' };

// Tiny spy (this pure-ESM Jest setup does not inject the `jest` global): records calls, runs impl.
const makeSpy = (impl) => {
  const fn = async (...args) => { fn.calls.push(args); return impl(...args); };
  fn.calls = [];
  return fn;
};

test('sign-in email uses the sign-in provider setting, then the default setting, then MailerSend', () => {
  expect(selectProvider('signin', { EMAIL_PROVIDER_SIGNIN: 'mailjet' })).toBe('mailjet');
  expect(selectProvider('signin', { EMAIL_PROVIDER_DEFAULT: 'mailjet' })).toBe('mailjet');
  expect(selectProvider('signin', {})).toBe('mailersend');
});

test('email with no category uses the default provider setting, or MailerSend when unset', () => {
  expect(selectProvider(undefined, { EMAIL_PROVIDER_DEFAULT: 'mailjet' })).toBe('mailjet');
  expect(selectProvider(undefined, {})).toBe('mailersend');
});

test('with fallback on, a failing provider falls back to the other one', async () => {
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

test('with fallback off, a failing provider\'s error is raised and the other provider is not tried', async () => {
  const mailersend = makeSpy(async () => { throw new Error('primary down'); });
  const mailjet = makeSpy(async () => ({ ok: true }));
  await expect(
    routeEmail({ to: 'a@b.c' }, { env: { EMAIL_FALLBACK_ENABLED: 'false' }, providers: { mailersend, mailjet } })
  ).rejects.toThrow('primary down');
  expect(mailjet.calls.length).toBe(0);
});

test('when the first provider succeeds the fallback is never called, so nothing is sent twice', async () => {
  const mailersend = makeSpy(async () => ({ ok: true }));
  const mailjet = makeSpy(async () => ({ ok: true }));
  await routeEmail({ to: 'a@b.c' }, { env: { EMAIL_FALLBACK_ENABLED: 'true' }, providers: { mailersend, mailjet } });
  expect(mailersend.calls.length).toBe(1);
  expect(mailjet.calls.length).toBe(0);
});

test('in test mode emails are captured, not sent', async () => {
  const res = await sendEmail({ to: 'x@y.z', subject: 'Subj', html: '<p>h</p>', category: 'signin' });
  expect(res).toEqual({ captured: true });
  const caps = getCapturedEmails();
  expect(caps[caps.length - 1]).toMatchObject({ to: 'x@y.z', subject: 'Subj', html: '<p>h</p>' });
});

test('the Mailjet adapter succeeds only when Mailjet reports success, and throws otherwise', async () => {
  const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ Messages: [{ Status: 'success' }] }) });
  await expect(mailjetSend({ to: 'a@b.c', subject: 's', html: '<p>h</p>' }, { fetchImpl: okFetch, env: mjEnv }))
    .resolves.toMatchObject({ success: true });

  const badStatus = async () => ({ ok: true, status: 200, json: async () => ({ Messages: [{ Status: 'error' }] }) });
  await expect(mailjetSend({ to: 'a@b.c', subject: 's', html: 'h' }, { fetchImpl: badStatus, env: mjEnv })).rejects.toThrow();

  const non2xx = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await expect(mailjetSend({ to: 'a@b.c', subject: 's', html: 'h' }, { fetchImpl: non2xx, env: mjEnv })).rejects.toThrow(/500/);
});

test('the Mailjet adapter maps our fields and sends inline and regular attachments separately', async () => {
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

test('the MailerSend adapter takes our options and treats a 202 as success', async () => {
  let body;
  const msFetch = async (url, opts) => { body = JSON.parse(opts.body); return { ok: true, status: 202, text: async () => '' }; };
  const res = await mailersendSend({ to: 'a@b.c', subject: 's', html: '<p>h</p>', text: 'h' }, { fetchImpl: msFetch });
  expect(res).toMatchObject({ success: true, status: 202 });
  expect(body.to).toEqual([{ email: 'a@b.c' }]);
  expect(body.subject).toBe('s');
});

test('all four account emails (welcome, verify, reset, deletion) are sent as sign-in email', async () => {
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

test('the paid-ticket buyer email is sent as event email', async () => {
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

test('with nothing configured every email goes through MailerSend only', async () => {
  const mailersend = makeSpy(async () => ({ ok: true }));
  const mailjet = makeSpy(async () => ({ ok: true }));
  await routeEmail({ to: 'a@b.c', category: 'signin' }, { env: {}, providers: { mailersend, mailjet } });
  await routeEmail({ to: 'a@b.c' }, { env: {}, providers: { mailersend, mailjet } });
  expect(mailersend.calls.length).toBe(2);
  expect(mailjet.calls.length).toBe(0);
});
