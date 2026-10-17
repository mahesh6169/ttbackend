// A logged-out visitor claims a coupon code by email - see featureplans/coupons-guest-code.md.
// The code + QR are emailed (never returned in the response); every existing coupon guard holds.
import request from 'supertest';
import app from '../../app.js';
import User from '../../models/userModel.js';
import CouponCode from '../../models/coupons/couponCode.js';
import Campaign from '../../models/coupons/campaign.js';
import { createOrganiser, createUser, createStore, createCampaign, API_KEY } from '../helpers/factories.js';
import { clearEmailsBeforeEach, getCapturedEmails, clearCapturedEmails } from '../helpers/email.js';

clearEmailsBeforeEach();

// Each claim uses a UNIQUE source IP so the shared in-memory rate limiter (keyed on the client IP,
// read from X-Forwarded-For) never bleeds one test's attempts into another. The rate-limit test
// opts out to reuse a single IP on purpose.
let ipSeq = 0;
const uniqueIp = () => `ip-${ipSeq++}`;

const claim = (body, ip = uniqueIp()) =>
  request(app)
    .post('/api/coupons/claim')
    .set('x-api-key', API_KEY)
    .set('X-Forwarded-For', ip)
    .send(body);

// A store + active campaign owned by a fresh organiser. Returns { owner, store, campaign }.
const seedCampaign = async (campaignOverrides = {}) => {
  const owner = await createOrganiser();
  const store = await createStore(owner);
  const campaign = await createCampaign(store, owner, campaignOverrides);
  return { owner, store, campaign };
};

test('a new email claim creates a guest and a code, emails the code and QR, and keeps both out of the response', async () => {
  const { store, campaign } = await seedCampaign();

  const res = await claim({ campaignId: String(campaign._id), email: 'philip@guest.dev', captchaToken: 'ok' });

  expect(res.status).toBe(201);
  expect(res.body.success).toBe(true);
  expect(res.body.alreadyClaimed).toBe(false);

  // A guest user record now exists.
  const guest = await User.findOne({ email: 'philip@guest.dev' });
  expect(guest).toBeTruthy();
  expect(guest.role).toBe('guest');

  // A code is tied to that guest for this campaign.
  const code = await CouponCode.findOne({ userId: guest._id, campaignId: campaign._id });
  expect(code).toBeTruthy();

  // The email to the guest contains the code and the QR image.
  const emails = getCapturedEmails();
  const toGuest = emails.find((e) => e.to === 'philip@guest.dev');
  expect(toGuest).toBeTruthy();
  expect(toGuest.html).toContain(code.userCode);
  expect(toGuest.html.toLowerCase()).toContain('qrserver'); // QR image src

  // Store + admin generate-code notifications fire for a guest claim too (a claim is a claim).
  expect(emails.some((e) => e.to === store.contactInfo.email)).toBe(true);

  // The response leaks neither the user code nor the full code, nor a couponCode object.
  const bodyText = JSON.stringify(res.body);
  expect(bodyText).not.toContain(code.userCode);
  expect(bodyText).not.toContain(code.fullCode);
  expect(res.body.couponCode).toBeUndefined();
});

test('claiming again makes no new code, leaves the campaign counters alone, and re-sends the same code', async () => {
  const { campaign } = await seedCampaign({ maxRedemptions: 10 });
  const email = 'reclaim@guest.dev';

  const first = await claim({ campaignId: String(campaign._id), email, captchaToken: 'ok' });
  expect(first.status).toBe(201);

  const code = await CouponCode.findOne({ campaignId: campaign._id });
  const generatedAfterFirst = (await Campaign.findById(campaign._id)).totalGenerated;

  clearCapturedEmails();
  const second = await claim({ campaignId: String(campaign._id), email, captchaToken: 'ok' });

  expect(second.status).toBe(200);
  expect(second.body.alreadyClaimed).toBe(true);
  expect(second.body.message).toMatch(/already claimed/i);

  // No new code, and the campaign counter did not move.
  expect(await CouponCode.countDocuments({ campaignId: campaign._id })).toBe(1);
  expect((await Campaign.findById(campaign._id)).totalGenerated).toBe(generatedAfterFirst);

  // The SAME code was re-emailed.
  const toGuest = getCapturedEmails().find((e) => e.to === email);
  expect(toGuest).toBeTruthy();
  expect(toGuest.html).toContain(code.userCode);
});

test('an email that already has a guest record reuses it instead of creating another', async () => {
  const { campaign } = await seedCampaign();
  const existingGuest = await createUser({ email: 'rsvp-guest@test.dev', role: 'guest' });

  const res = await claim({ campaignId: String(campaign._id), email: 'rsvp-guest@test.dev', captchaToken: 'ok' });
  expect(res.status).toBe(201);

  const guests = await User.find({ email: 'rsvp-guest@test.dev' });
  expect(guests.length).toBe(1);
  expect(String(guests[0]._id)).toBe(String(existingGuest._id));

  const code = await CouponCode.findOne({ campaignId: campaign._id });
  expect(String(code.userId)).toBe(String(existingGuest._id));
});

test('an email that belongs to a member account is refused, with no code and no email', async () => {
  const { campaign } = await seedCampaign();
  await createUser({ email: 'member@test.dev' }); // role 'user'

  clearCapturedEmails();
  const res = await claim({ campaignId: String(campaign._id), email: 'member@test.dev', captchaToken: 'ok' });

  expect(res.status).toBe(409);
  expect(res.body.code).toBe('ACCOUNT_EXISTS');
  expect(res.body.message).toMatch(/has an account/i);

  expect(await CouponCode.countDocuments({ campaignId: campaign._id })).toBe(0);
  expect(getCapturedEmails().length).toBe(0);
});

test('an expired campaign cannot be claimed', async () => {
  const { campaign } = await seedCampaign({ expiryDate: new Date(Date.now() - 24 * 3600 * 1000) });

  const res = await claim({ campaignId: String(campaign._id), email: 'late@guest.dev', captchaToken: 'ok' });

  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/expired/i);
  expect(await CouponCode.countDocuments({ campaignId: campaign._id })).toBe(0);
});

test('a campaign at its code limit cannot be claimed', async () => {
  const { campaign } = await seedCampaign({ maxRedemptions: 1 });

  const first = await claim({ campaignId: String(campaign._id), email: 'a@guest.dev', captchaToken: 'ok' });
  expect(first.status).toBe(201);

  const second = await claim({ campaignId: String(campaign._id), email: 'b@guest.dev', captchaToken: 'ok' });
  expect(second.status).toBe(400);
  expect(second.body.message).toMatch(/limit|maximum/i);

  expect(await CouponCode.countDocuments({ campaignId: campaign._id })).toBe(1);
});

// Code generation is atomic, so parallel claims cannot overshoot the cap.
test('claims racing for the last code never go over the limit', async () => {
  const { campaign } = await seedCampaign({ maxRedemptions: 1 });

  const fire = (email) =>
    claim({ campaignId: String(campaign._id), email, captchaToken: 'ok' }).catch(() => null);

  const results = await Promise.all([
    fire('r1@guest.dev'),
    fire('r2@guest.dev'),
    fire('r3@guest.dev'),
  ]);

  const created = results.filter((r) => r && r.status === 201);
  expect(created.length).toBe(1);
  expect(await CouponCode.countDocuments({ campaignId: campaign._id })).toBe(1);
  expect((await Campaign.findById(campaign._id)).totalGenerated).toBe(1);
});

test('an invalid email address is refused', async () => {
  const { campaign } = await seedCampaign();

  const res = await claim({ campaignId: String(campaign._id), email: 'not-an-email', captchaToken: 'ok' });

  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/valid email/i);
  expect(await CouponCode.countDocuments({ campaignId: campaign._id })).toBe(0);
});

// (A live-failed captcha token is rejected by Google in the e2e
// run under the always-pass test key; backend verification is short-circuited in test mode, so the
// presence check is the guard exercised here.)
test('a claim without a captcha token is refused', async () => {
  const { campaign } = await seedCampaign();

  const res = await claim({ campaignId: String(campaign._id), email: 'nocaptcha@guest.dev' });

  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/captcha/i);
  expect(await CouponCode.countDocuments({ campaignId: campaign._id })).toBe(0);
});

// A guest-claimed code goes through the same public validate/redeem flow as a member code.
test('a guest\'s code validates and redeems once, and cannot be redeemed twice', async () => {
  const { campaign } = await seedCampaign();
  await claim({ campaignId: String(campaign._id), email: 'redeemer@guest.dev', captchaToken: 'ok' });
  const code = await CouponCode.findOne({ campaignId: campaign._id });

  const publicPost = (path, payload) =>
    request(app).post(path).set('x-api-key', API_KEY).set('X-Forwarded-For', uniqueIp()).send(payload);

  const validated = await publicPost('/api/coupons/validate', { fullCode: code.fullCode });
  expect(validated.status).toBe(200);
  expect(validated.body.validation.isValid).toBe(true);

  const firstRedeem = await publicPost('/api/coupons/redeem', { fullCode: code.fullCode });
  expect(firstRedeem.status).toBe(200);
  expect(firstRedeem.body.success).toBe(true);

  const secondRedeem = await publicPost('/api/coupons/redeem', { fullCode: code.fullCode });
  expect(secondRedeem.status).toBe(400);

  expect((await CouponCode.findById(code._id)).isRedeemed).toBe(true);
});

test('rapid repeated claims from one address are rate limited', async () => {
  const { campaign } = await seedCampaign();
  const burstIp = 'burst-ip';

  const statuses = [];
  for (let i = 0; i < 35; i++) {
    const res = await claim(
      { campaignId: String(campaign._id), email: 'burst@guest.dev', captchaToken: 'ok' },
      burstIp
    );
    statuses.push(res.status);
  }

  expect(statuses).toContain(429);
});
