// Acceptance suite for featureplans/coupons-guest-code.md - a logged-out visitor claims a coupon
// code by email. The code + QR are emailed (never returned); every existing coupon guard holds.
import request from 'supertest';
import app from '../app.js';
import User from '../models/userModel.js';
import CouponCode from '../models/coupons/couponCode.js';
import Campaign from '../models/coupons/campaign.js';
import { createOrganiser, createUser, createStore, createCampaign, API_KEY } from './helpers/factories.js';
import { getCapturedEmails, clearCapturedEmails } from '../utils/notifications/sendEmail.js';

beforeEach(() => clearCapturedEmails());

// Each claim uses a UNIQUE source IP so the shared in-memory rate limiter (keyed on the client IP,
// read from X-Forwarded-For) never bleeds one test's attempts into another. AC8 opts out to reuse
// a single IP on purpose.
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

// AC1: a new email claiming an active campaign creates a guest user + a code tied to it; the email
// to that address carries the code and its QR; the API response carries NEITHER the code nor the QR.
test('AC1 [api]: new email claim creates guest + code, emails code+QR, hides both from the response', async () => {
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

// AC2: the same email claiming the same campaign again creates NO new code (count + campaign
// counters unchanged), returns the friendly already-claimed message, and re-sends the SAME code.
test('AC2 [api]: re-claim makes no new code, leaves counters untouched, and re-sends the same code', async () => {
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

// AC3: an email that already has a guest record (e.g. from an events RSVP) is reused - no duplicate
// user - and the code ties to that existing record.
test('AC3 [api]: an existing guest record is reused, not duplicated', async () => {
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

// AC4: a full-account (member) email is refused with the has-an-account message; no code, no email.
test('AC4 [api]: a member email is refused; no code created and no email sent', async () => {
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

// AC5: campaign guards hold for guest claims - expired is refused.
test('AC5 [api]: an expired campaign is refused', async () => {
  const { campaign } = await seedCampaign({ expiryDate: new Date(Date.now() - 24 * 3600 * 1000) });

  const res = await claim({ campaignId: String(campaign._id), email: 'late@guest.dev', captchaToken: 'ok' });

  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/expired/i);
  expect(await CouponCode.countDocuments({ campaignId: campaign._id })).toBe(0);
});

// AC5: a campaign already at its maxRedemptions cap is refused.
test('AC5 [api]: a campaign at its maxRedemptions cap is refused', async () => {
  const { campaign } = await seedCampaign({ maxRedemptions: 1 });

  const first = await claim({ campaignId: String(campaign._id), email: 'a@guest.dev', captchaToken: 'ok' });
  expect(first.status).toBe(201);

  const second = await claim({ campaignId: String(campaign._id), email: 'b@guest.dev', captchaToken: 'ok' });
  expect(second.status).toBe(400);
  expect(second.body.message).toMatch(/limit|maximum/i);

  expect(await CouponCode.countDocuments({ campaignId: campaign._id })).toBe(1);
});

// AC5: parallel claims racing the last cap slot never exceed it (atomic generation).
test('AC5 [api]: parallel claims racing the last cap slot never exceed the cap', async () => {
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

// AC6: an invalid email format is refused with a clear message.
test('AC6 [api]: an invalid email format is refused', async () => {
  const { campaign } = await seedCampaign();

  const res = await claim({ campaignId: String(campaign._id), email: 'not-an-email', captchaToken: 'ok' });

  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/valid email/i);
  expect(await CouponCode.countDocuments({ campaignId: campaign._id })).toBe(0);
});

// AC6: a missing captcha token is refused. (A live-failed token is rejected by Google in the e2e
// run under the always-pass test key; backend verification is short-circuited in test mode, so the
// presence check is the guard exercised here.)
test('AC6 [api]: a missing captcha token is refused', async () => {
  const { campaign } = await seedCampaign();

  const res = await claim({ campaignId: String(campaign._id), email: 'nocaptcha@guest.dev' });

  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/captcha/i);
  expect(await CouponCode.countDocuments({ campaignId: campaign._id })).toBe(0);
});

// AC7: a guest-claimed code passes the public validate flow and redeems atomically exactly like a
// member code; a second redeem attempt fails (single-use holds).
test('AC7 [api]: a guest code validates, redeems once, and cannot be redeemed twice', async () => {
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

// AC8: rapid repeated claims from one IP trip the rate limit.
test('AC8 [api]: rapid repeated claims from one IP trip the rate limit', async () => {
  const { campaign } = await seedCampaign();
  const burstIp = 'burst-ip-ac8';

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
