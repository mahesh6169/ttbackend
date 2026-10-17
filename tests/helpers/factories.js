// Seed helpers for the backend test suites. They write valid docs straight through the models
// and mint JWT cookies, so a suite can set up exactly the state it needs. See the model files
// for the required-field shapes reproduced here.
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import User from '../../models/userModel.js';
import Event from '../../models/eventModel.js';
import FreeTicket from '../../models/freeTicket.js';
import PaidTicket from '../../models/paidTicket.js';
import Thread from '../../models/threadModel.js';
import Store from '../../models/coupons/store.js';
import Campaign from '../../models/coupons/campaign.js';
import Advert from '../../models/advertModel.js';
import PartnerStore from '../../models/dailydeals/partnerStore.js';
import DailyDeal from '../../models/dailydeals/dailyDeal.js';
import { BannerBusiness, BannerPlacement, BannerAd } from '../../models/bannerAds/index.js';

// The fake API key apiKeyAuth accepts in test env (from .env.test). Attach to every request.
export const API_KEY = process.env.FRONTEND_API_KEY;

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${seq++}`;

const MEMBER_SUBURB = {
  name: 'Sydney',
  state: 'NSW',
  postalCode: '2000',
  location: { type: 'Point', coordinates: [151.2093, -33.8688] },
};

// Create a user. role defaults to 'user'; guests skip password/suburb (optional for that role).
export const createUser = async (overrides = {}) => {
  const role = overrides.role || 'user';
  const { password, ...rest } = overrides;
  const doc = {
    email: `user_${uniq()}@test.dev`,
    name: 'Test User',
    role,
    isAccountVerified: true,
    ...(role !== 'guest'
      ? { password: await bcrypt.hash(password || 'test1234', 10), suburb: MEMBER_SUBURB }
      : {}),
    ...rest,
  };
  return User.create(doc);
};

// An organiser is a normal user with a fully-active test-mode Stripe connected account.
export const createOrganiser = (overrides = {}) =>
  createUser({
    name: 'Test Organiser',
    stripeAccountId: process.env.TEST_STRIPE_ACCOUNT_ID,
    stripeAccountStatus: 'fully_active',
    stripeChargesEnabled: true,
    stripePayoutsEnabled: true,
    stripeDetailsSubmitted: true,
    paidHost: true,
    ...overrides,
  });

// Mint the same JWT the login flow issues, as a Cookie header value for Supertest.
export const tokenFor = (user) =>
  jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
export const cookieFor = (user) => `token=${tokenFor(user)}`;

const eventBase = (organiser, overrides) => {
  const now = Date.now();
  return {
    eventCode: `EVT-${uniq()}`.toUpperCase(),
    title: 'Test Event',
    description: 'A seeded event for automated tests.',
    category: 'Community',
    dateTime: new Date(now + 7 * 24 * 3600 * 1000),
    timeZone: 'Australia/Sydney',
    venue: 'Test Hall',
    address: {
      formattedAddress: '1 Test St, Sydney NSW 2000',
      suburb: 'Sydney',
      state: 'NSW',
      location: { type: 'Point', coordinates: [151.2093, -33.8688] },
    },
    postedBy: organiser._id,
    capacity: 100,
    maxAttendeesPerRegistration: 5,
    status: 'active',
    expiryDate: new Date(now + 30 * 24 * 3600 * 1000),
    goLive: true,
    ...overrides,
  };
};

// Seeded events carry a valid organiser (name + AU-mobile contact) so the create wizard's Step-2
// validation (events-wizard-validation.md D6) passes when a spec edits them.
const ORGANISER = { name: 'Test Organiser', contact: '0412345678' };

export const createFreeEvent = (organiser, overrides = {}) =>
  Event.create(eventBase(organiser, { title: 'Test Free Event', isPaid: false, organizer: ORGANISER, ...overrides }));

// A free-event RSVP registration (FreeTicket) for `event`, booked by `user`. Carries the
// eventSnapshot.postedBy the check-in/cancel endpoints authorise against, so the organiser owns
// it. Override attendees (name + checkedIn), formResponses, registrationNumber, status, etc.
export const createFreeRegistration = (event, user, overrides = {}) => {
  const { attendees, formResponses, registrationNumber, email, mobile, status, ...rest } = overrides;
  return FreeTicket.create({
    event: event._id,
    registrationNumber: registrationNumber || `RC-${uniq()}`.toUpperCase(),
    user: user._id,
    email: email || user.email,
    mobile: mobile || '0412345678',
    attendees: attendees || [{ name: 'Attendee One', checkedIn: false }],
    formResponses: formResponses || [],
    eventSnapshot: {
      eventCode: event.eventCode,
      title: event.title,
      dateTime: event.dateTime,
      timeZone: event.timeZone,
      venue: event.venue,
      capacity: event.capacity,
      postedBy: String(event.postedBy),
    },
    status: status || 'registered',
    ...rest,
  });
};

export const createPaidEvent = (organiser, overrides = {}) =>
  Event.create(
    eventBase(organiser, {
      title: 'Test Paid Event',
      isPaid: true,
      ticketTypes: [{ name: 'Standard', price: 10 }],
      organizer: ORGANISER,
      ...overrides,
    })
  );

// A paid ticket (PaidTicket) for `event`, purchased by `buyerUser`. Carries the eventSnapshot
// (postedBy String, isPaid, status:'active') the paid check-in endpoints authorise against, and a
// unique ticketNumber/invoiceNumber. Note PaidTicket.event is a STRING (not ObjectId). Override
// ticketNumber, invoiceNumber, attendees, checkInStatus ('confirmed'|'checked-in'|'cancelled'),
// ticketType, seats, formResponses, buyer, and price (sets ticketType.price + priceDetails; default 10).
let paidTicketSeq = 0;
export const createPaidTicket = (event, buyerUser, overrides = {}) => {
  const { attendees, ticketNumber, invoiceNumber, checkInStatus, ticketType, seats, formResponses, buyer, price = 10, ...rest } = overrides;
  const n = `${uniq()}${paidTicketSeq++}`.toUpperCase();
  return PaidTicket.create({
    event: String(event._id),
    ticketNumber: ticketNumber || `TKT-${n}`,
    invoiceNumber: invoiceNumber || `INV-${n}`,
    user: buyerUser._id,
    ticketType: ticketType || { name: 'Standard', price },
    priceDetails: { basePrice: price, totalPrice: price },
    seats: seats || [],
    buyer: buyer || { firstName: 'Buyer', lastName: 'One', email: buyerUser.email, agreedToTerms: true },
    attendees: attendees || [{ name: 'Buyer One', checkedIn: false }],
    formResponses: formResponses || [],
    checkInStatus: checkInStatus || 'confirmed',
    refundStatus: 'none',
    totalRefundedAmount: 0,
    refundPolicyAcceptance: { policyType: 'non-refundable', accepted: true },
    eventSnapshot: {
      eventCode: event.eventCode,
      title: event.title,
      dateTime: event.dateTime,
      timeZone: event.timeZone,
      venue: event.venue,
      postedBy: String(event.postedBy),
      isPaid: true,
      status: 'active',
      capacity: event.capacity,
    },
    ...rest,
  });
};

// A coupon store owned by `owner`. storeIdentifier must be a unique <=5-char uppercase tag (it
// prefixes every generated fullCode, e.g. ST000-12345); a per-run counter keeps it collision-free.
let storeSeq = 0;
const nextStoreIdentifier = () => `ST${String(storeSeq++).padStart(3, '0')}`;

const storeBase = (owner, overrides) => ({
  storeIdentifier: nextStoreIdentifier(),
  storeName: 'Test Store',
  category: 'Food',
  subcategory: 'Restaurant',
  address: {
    formattedAddress: '1 Test St, Sydney NSW 2000',
    suburb: 'Sydney',
    state: 'NSW',
    postalCode: '2000',
    location: { type: 'Point', coordinates: [151.2093, -33.8688] },
  },
  contactInfo: { phone: '0212345678', email: 'store@test.dev' },
  isActive: true,
  createdBy: owner._id,
  ...overrides,
});

export const createStore = (owner, overrides = {}) =>
  Store.create(storeBase(owner, overrides));

// A coupon campaign under `store`, owned by `owner`. Defaults: active, expires 30 days out, no
// weekday restriction (validDays: [] => valid every day, so redeem passes regardless of run day),
// unlimited codes. Override expiryDate / maxRedemptions / validDays to exercise the guards.
const campaignBase = (store, owner, overrides) => {
  const now = Date.now();
  return {
    storeId: store._id,
    campaignName: `Test Campaign ${uniq()}`,
    slug: `test-campaign-${uniq()}`,
    discount: '20% off',
    discountProduct: 'all items',
    termsConditions: 'Dine-in only.',
    expiryDate: new Date(now + 30 * 24 * 3600 * 1000),
    validDays: [],
    validHours: [],
    isActive: true,
    isHidden: false,
    maxRedemptions: 0,
    createdBy: owner._id,
    ...overrides,
  };
};

export const createCampaign = (store, owner, overrides = {}) =>
  Campaign.create(campaignBase(store, owner, overrides));

// A servable side-rail banner ad for a placement ('LEFT' / 'RIGHT'): an active national ad
// (empty targetStates -> serves to everyone) inside a wide schedule window, plus the
// BannerPlacement doc the serve endpoint looks up by placementId. The frontend LeftAd/RightAd
// fetch /bannerAds/serve/<placement>; with this seeded, the rails render on desktop. Used by
// the layout-tiers spec to prove the rails are desktop-only (lg+).
const AD_IMAGE_URL =
  'https://res.cloudinary.com/dtvrbdvkx/image/upload/v1764066113/ogshare_v4_psldb7.jpg';
export const createBannerRailAd = async (placementId, overrides = {}) => {
  const business = await BannerBusiness.create({
    businessId: `BIZ-${uniq()}`.toUpperCase(),
    name: 'E2E Ads Co',
    contact: { email: `ads_${uniq()}@test.dev` },
    status: 'active',
  });
  const adId = `AD-${placementId}-${uniq()}`.toUpperCase();
  const ad = await BannerAd.create({
    adId,
    name: `E2E ${placementId} Ad`,
    businessId: String(business._id),
    placements: [placementId],
    targetStates: [],
    schedule: { startAt: new Date('2020-01-01'), endAt: new Date('2999-01-01') },
    status: 'active',
    creative: {
      desktop: {
        images: [{ imageUrl: AD_IMAGE_URL, order: 0 }],
        altText: `E2E ${placementId} advertisement`,
        destination: { type: 'external', url: 'https://example.com' },
      },
    },
    ...overrides,
  });
  await BannerPlacement.create({
    placementId,
    name: `E2E ${placementId} placement`,
    assignedAds: [{ adId, order: 0 }],
    rotationIndex: 0,
  });
  return ad;
};

// A partner store (deals vertical) owned by `owner`. partnerstoreId must be a unique uppercase
// tag; a per-run counter keeps it collision-free.
let partnerStoreSeq = 0;
const nextPartnerStoreId = () => `PS${String(partnerStoreSeq++).padStart(4, '0')}`;

export const createPartnerStore = (owner, overrides = {}) =>
  PartnerStore.create({
    partnerstoreId: nextPartnerStoreId(),
    businessName: 'Test Partner Store',
    category: 'Food',
    subcategory: 'Restaurant',
    address: {
      formattedAddress: '1 Test St, Sydney NSW 2000',
      suburb: 'Sydney', state: 'NSW', postalCode: '2000',
      location: { type: 'Point', coordinates: [151.2093, -33.8688] },
    },
    contactInfo: { phone: '0212345678', email: 'partner@test.dev' },
    isActive: true,
    createdBy: owner._id,
    ...overrides,
  });

// A daily deal under `store`, posted by `poster`. Defaults to an ACTIVE, ONLINE deal that is
// in-date now (startDate in the past, endDate in the future) so it appears in browse and the
// sitemap. Override isActive / isOnline / startDate / endDate to exercise the filters.
export const createDeal = (store, poster, overrides = {}) => {
  const now = Date.now();
  return DailyDeal.create({
    partnerstoreId: store._id,
    dealTitle: 'Test Deal',
    description: 'A seeded deal for automated tests.',
    startDate: new Date(now - 24 * 3600 * 1000),
    endDate: new Date(now + 30 * 24 * 3600 * 1000),
    isActive: true,
    isOnline: true,
    postedBy: poster._id,
    ...overrides,
  });
};

// An advert (listings vertical) posted by `poster`. Defaults to an active, unexpired listing so
// its slug detail page resolves.
export const createAdvert = (poster, overrides = {}) => {
  const now = Date.now();
  return Advert.create({
    title: 'Test Listing',
    category: 'ForSale',
    description: 'A seeded listing for automated tests.',
    address: {
      formattedAddress: '1 Test St, Sydney NSW 2000',
      suburb: 'Sydney', state: 'NSW', postalCode: '2000',
      location: { type: 'Point', coordinates: [151.2093, -33.8688] },
    },
    postedBy: poster._id,
    status: 'active',
    expiresAt: new Date(now + 30 * 24 * 3600 * 1000),
    ...overrides,
  });
};

// A thread owned by `owner`. Pass `question` to seed legacy plain text or rich HTML.
export const createThread = (owner, overrides = {}) =>
  Thread.create({
    title: 'Test Thread',
    question: 'A seeded thread.',
    category: 'General',
    owner: owner._id,
    participants: [owner._id],
    suburb: {
      name: 'Sydney', state: 'NSW', postalCode: '2000',
      location: { type: 'Point', coordinates: [151.2093, -33.8688] },
    },
    ...overrides,
  });
