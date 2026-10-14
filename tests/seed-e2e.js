// Seeds the test DB for the Playwright E2E run. Loads .env.test + the three guards (via
// setup.env.js), drops the test database for a clean slate, then creates an organiser, a member,
// a free event and a paid event, printing their ids as SEED_JSON=... for the Playwright global
// setup to read. Invoked by e2e/global.setup.js, never in dev/prod.
import './setup.env.js';
import mongoose from 'mongoose';
import PaidTicket from '../models/paidTicket.js';
import { createOrganiser, createUser, createFreeEvent, createPaidEvent, createFreeRegistration, createPaidTicket, createThread, createStore, createCampaign, createBannerRailAd, createPartnerStore, createDeal, createAdvert } from './helpers/factories.js';

await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.dropDatabase();

const organiser = await createOrganiser();
const member = await createUser({ email: 'e2e-member@test.dev', password: 'test1234', name: 'E2E Member' });
// Admin login (events-delete-retention.md AC10): drives the renewals/purge admin pages.
const adminUser = await createUser({ email: 'e2e-admin@test.dev', password: 'test1234', name: 'E2E Admin', role: 'admin' });
const freeEvent = await createFreeEvent(organiser, { title: 'E2E Free Fest' });
const paidEvent = await createPaidEvent(organiser, { title: 'E2E Paid Fest', capacity: 50 });

// A non-seated paid event carrying a refund policy AND organiser Terms & Conditions, for
// events-terms-conditions.md (the T&C follows the refund policy through checkout etc.).
const termsEvent = await createPaidEvent(organiser, {
  title: 'E2E Terms Fest', capacity: 50, maxAttendeesPerRegistration: 10,
  ticketTypes: [{ name: 'Standard', price: 10 }],
  refundPolicy: {
    processingFeePolicy: 'non-refundable',
    policyText: 'No change of mind.',
    termsAndConditions: 'E2E TERMS: no outside food or drink; entry subject to venue conditions.',
  },
});

// Seat-builder spec: a known-credential organiser (so e2e can EDIT its events - editing bypasses the
// Stripe gate and the Google Places address step). One event with NO seating (empty layout -> no frozen
// rows -> Generate/tools allowed), one seated event with a SOLD seat (frozen rows + booked-unclickable).
const builderOrganiser = await createOrganiser({ email: 'e2e-organiser@test.dev', password: 'test1234', name: 'E2E Organiser' });
const builderEmptyEvent = await createPaidEvent(builderOrganiser, { title: 'E2E Builder Empty', capacity: 400 });
const builderSoldSeats = (label, n, bookedNum) =>
  Array.from({ length: n }, (_, i) => ({
    seatId: `${label}-${i + 1}`, seatNumber: String(i + 1), row: label,
    status: (i + 1) === bookedNum ? 'booked' : 'available',
  }));
const builderSoldEvent = await createPaidEvent(builderOrganiser, {
  title: 'E2E Builder Sold', capacity: 20,
  seatingLayout: [
    { rowLabel: 'A', seats: builderSoldSeats('A', 10, 3) }, // A-3 sold
    { rowLabel: 'B', seats: builderSoldSeats('B', 10, null) },
  ],
});
// Builder-attendee parity: a seated event with a walkway AND an organiser-reserved seat (A-3), so the
// attendee map can be checked to render the same amber aisle + purple reserved seat the builder shows.
const paritySeats = (label, n, reservedNum) =>
  Array.from({ length: n }, (_, i) => ({
    seatId: `${label}-${i + 1}`, seatNumber: String(i + 1), row: label,
    status: (i + 1) === reservedNum ? 'reserved' : 'available',
    reservedBy: null, reservedUntil: null,
  }));
const builderParityEvent = await createPaidEvent(builderOrganiser, {
  title: 'E2E Builder Parity', capacity: 16,
  organizerReservedSeats: 'A3',
  seatingLayout: [
    { rowLabel: 'A', walkwayPositions: [5], seats: paritySeats('A', 8, 3) },
    { rowLabel: 'B', walkwayPositions: [5], seats: paritySeats('B', 8, null) },
  ],
});

// Edit-locking spec (featureplans/events-edit-locking.md AC6/AC12): events owned by the known-
// credential organiser so the e2e can EDIT them. One PAID event with a SOLD ticket type (hasSold)
// beside an unsold one - the sold type's name/price/bundle must be disabled in the edit form. One
// event with activity + an existing attendee question - the question must be locked in the edit form.
const editLockSoldEvent = await createPaidEvent(builderOrganiser, {
  title: 'E2E Edit Lock Sold', capacity: 100, hasActivity: true,
  ticketTypes: [{ name: 'Sold', price: 10, hasSold: true }, { name: 'Open', price: 12 }],
});
const editLockQuestionEvent = await createFreeEvent(builderOrganiser, {
  title: 'E2E Edit Lock Question', capacity: 100, hasActivity: true,
  registrationFields: [{ fieldName: 'Dietary needs', fieldType: 'text', isRequired: false }],
});
// A paid event with one on-sale type and one STOPPED type (active:false) - the buy page and the
// event detail page must hide the stopped one (events-edit-locking.md stop-selling extension).
const editLockStoppedEvent = await createPaidEvent(organiser, {
  title: 'E2E Edit Lock Stopped', capacity: 100, maxAttendeesPerRegistration: 10,
  ticketTypes: [{ name: 'OpenPass', price: 10 }, { name: 'ClosedPass', price: 12, active: false }],
});

// A paid event with 5 confirmed tickets, so its edit-load committedCount = 5 and the capacity floor
// (D11/AC10) engages: typing a capacity below 5 must show an inline reason.
const editLockCapacityEvent = await createPaidEvent(builderOrganiser, {
  title: 'E2E Edit Lock Capacity', capacity: 100, hasActivity: true, ticketTypes: [{ name: 'Standard', price: 10 }],
});
for (let i = 0; i < 5; i++) {
  await PaidTicket.create({
    event: String(editLockCapacityEvent._id),
    ticketNumber: `EL-CAP-${i}`,
    invoiceNumber: 'INV-ELCAP-0001',
    user: builderOrganiser._id,
    eventSnapshot: { eventCode: editLockCapacityEvent.eventCode, title: editLockCapacityEvent.title, postedBy: builderOrganiser._id.toString() },
    ticketType: { name: 'Standard', price: 10 },
    priceDetails: { basePrice: 10, totalPrice: 10 },
    buyer: { firstName: 'Cap', lastName: 'Buyer', email: 'elcap@test.dev', agreedToTerms: true },
    attendees: [{ name: 'Cap Buyer' }],
    refundPolicyAcceptance: { policyType: 'non-refundable', accepted: true },
    checkInStatus: 'confirmed', refundStatus: 'none', totalRefundedAmount: 0,
  });
}

// Wizard-validation spec (featureplans/events-wizard-validation.md AC20/D13): a paid event whose
// refund policy is explicitly empty. The model default is 'non-refundable', so we pass an explicit
// '' (defaults only fill undefined paths) to reproduce a wizard state with NO chosen policy - the
// only way to prove edit-mode blocks the final action until the organiser picks one.
const noRefundEvent = await createPaidEvent(builderOrganiser, {
  title: 'E2E No Refund Policy', capacity: 400,
  refundPolicy: { processingFeePolicy: '' },
});

// Bundle events for the bundle specs. Ticket types are seeded in stored form: a bundle stores the
// PACK price as price + bundleSize (events-bundle-pricing.md D1 - no hidden per-person share).
// FamilyFour: $72 pack admits 4 (splits into 4 x $18 at issuance). Non-seated unless noted.
const bundleTicketTypes = [{ name: 'FamilyFour', price: 72, bundleSize: 4 }];

// Flagship purchase + issuance/capacity checks (ample capacity).
const bundleEvent = await createPaidEvent(organiser, {
  title: 'E2E Bundle Fest', capacity: 30, maxAttendeesPerRegistration: 10, ticketTypes: bundleTicketTypes,
});
// Clamps + display: a bundle alongside a normal type, roomy per-order limit.
const bundleClampEvent = await createPaidEvent(organiser, {
  title: 'E2E Bundle Clamp Fest', capacity: 30, maxAttendeesPerRegistration: 10,
  ticketTypes: [{ name: 'FamilyFour', price: 72, bundleSize: 4 }, { name: 'General', price: 25 }],
});
// Tight capacity: only 3 spots, so a pack of 4 can never fit (pack-aware disable message).
const bundleTightEvent = await createPaidEvent(organiser, {
  title: 'E2E Bundle Tight Fest', capacity: 3, maxAttendeesPerRegistration: 10, ticketTypes: bundleTicketTypes,
});
// Mixed cart (pack + single) for the return-navigation restore spec — isolated from the clamp spec.
const bundleRestoreEvent = await createPaidEvent(organiser, {
  title: 'E2E Bundle Restore Fest', capacity: 30, maxAttendeesPerRegistration: 10,
  ticketTypes: [{ name: 'FamilyFour', price: 72, bundleSize: 4 }, { name: 'General', price: 25 }],
});
// Seated variant of the restore event — the seated capacity response defines `available`, which arms
// the tickets page's "clear stale selection" effect that stays dormant for general-admission events.
const restoreSeatLayout = ['A', 'B', 'C', 'D', 'E', 'F'].map((r) => ({
  rowLabel: r,
  seats: [1, 2, 3, 4, 5].map((n) => ({ seatId: `${r}-${n}`, seatNumber: String(n), row: r, status: 'available' })),
}));
const bundleRestoreSeatedEvent = await createPaidEvent(organiser, {
  title: 'E2E Bundle Restore Seated Fest', capacity: 30, maxAttendeesPerRegistration: 10,
  ticketTypes: [{ name: 'FamilyFour', price: 72, bundleSize: 4 }, { name: 'General', price: 25 }],
  seatingLayout: restoreSeatLayout,
});

// Pack-pricing spec (events-bundle-pricing.md AC19/AC20): a FamilyPack that stores the PACK price
// $50 for 3 (does NOT divide evenly - splits into 16.67/16.67/16.66 at issuance). One non-seated
// event for the general-admission purchase, one seated event where a pack demands exactly 3 seats.
const packPricingEvent = await createPaidEvent(organiser, {
  title: 'E2E Pack Pricing Fest', capacity: 30, maxAttendeesPerRegistration: 6,
  ticketTypes: [{ name: 'FamilyPack', price: 50, bundleSize: 3 }],
});
const packSeatLayout = ['A', 'B'].map((r) => ({
  rowLabel: r,
  seats: [1, 2, 3, 4, 5].map((n) => ({ seatId: `${r}-${n}`, seatNumber: String(n), row: r, status: 'available' })),
}));
const packPricingSeatedEvent = await createPaidEvent(organiser, {
  title: 'E2E Pack Pricing Seated Fest', capacity: 10, maxAttendeesPerRegistration: 6,
  ticketTypes: [{ name: 'FamilyPack', price: 50, bundleSize: 3 }],
  seatingLayout: packSeatLayout,
});

// Seat-count-sync spec (featureplans/fix-events-seatcount-sync.md): a plain seated event, single
// ticket type, room for 6+ seats - so the buyer can reserve 5, hold 5, go back and raise to 6, and
// pick a 6th. Dedicated so its held seats never interfere with the other seated specs.
const seatSyncLayout = ['A', 'B'].map((r) => ({
  rowLabel: r,
  seats: Array.from({ length: 10 }, (_, i) => ({ seatId: `${r}-${i + 1}`, seatNumber: String(i + 1), row: r, status: 'available' })),
}));
const seatSyncEvent = await createPaidEvent(organiser, {
  title: 'E2E Seat Sync Fest', capacity: 20, maxAttendeesPerRegistration: 8,
  ticketTypes: [{ name: 'Standard', price: 10 }],
  seatingLayout: seatSyncLayout,
});

// Blocking-questions RSVP (featureplans/events-rsvp-blocking-questions.md): a free event with a
// dropdown question where "No" blocks registration, plus a custom block message.
const blockingRsvpEvent = await createFreeEvent(organiser, {
  title: 'E2E Blocking RSVP Fest', capacity: 100,
  registrationFields: [{
    fieldName: 'Are you 18 or over?', fieldType: 'select',
    fieldOptions: ['Yes', 'No'], blockingOptions: ['No'],
    blockingMessage: 'Sorry, this event is 18+ only.', isRequired: true,
  }],
});

// Events-by-organiser page (featureplans/events-by-organiser.md): an organiser with a stable slug and
// two published upcoming events (the heading uses the event's organizer.name), and a second organiser
// with a slug but NO events (the empty state). The slug is set here the way the owner sets it by hand.
const orgPageUser = await createOrganiser({ email: 'e2e-orgpage@test.dev', slug: 'sydney-events-co' });
const ORG_PAGE_NAME = 'Sydney Events Co';
await createFreeEvent(orgPageUser, { title: 'Org Page Free Fest', organizer: { name: ORG_PAGE_NAME, contact: '0412345678' } });
await createPaidEvent(orgPageUser, { title: 'Org Page Paid Fest', organizer: { name: ORG_PAGE_NAME, contact: '0412345678' } });
const orgEmptyUser = await createOrganiser({ email: 'e2e-orgempty@test.dev', name: 'Quiet Organiser', slug: 'quiet-organiser' });

// Organiser page share card (featureplans/events-organiser-share-meta.md): an organiser carrying all
// three optional share fields, so its /events/by/{slug} head uses the custom card. The default-card
// case reuses orgPageUser above (no share fields set). Set here by hand the way the owner sets them.
const ORG_SHARE_NAME = 'Aurora Events';
const ORG_SHARE_TITLE = 'Diwali Nights by Aurora Events';
const ORG_SHARE_DESCRIPTION = 'Book your Diwali tickets before they sell out!';
const ORG_SHARE_IMAGE = 'https://cdn.example.com/aurora-share.jpg';
const orgShareUser = await createOrganiser({
  email: 'e2e-orgshare@test.dev',
  slug: 'aurora-share-co',
  organiserShareTitle: ORG_SHARE_TITLE,
  organiserShareDescription: ORG_SHARE_DESCRIPTION,
  organiserShareImage: ORG_SHARE_IMAGE,
});
await createFreeEvent(orgShareUser, { title: 'Aurora Diwali Fest', organizer: { name: ORG_SHARE_NAME, contact: '0412345678' } });

// Threads for the rich-editor spec, owned by the member (so the edit spec can open + save them).
const threadRich = await createThread(member, {
  title: 'E2E Rich Thread',
  question:
    '<p>Intro <strong>bold</strong> line</p>' +
    '<ul><li>one</li><li>two</li></ul>' +
    '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a></p>',
});
// A separate rich thread only the edit spec touches - its slug page is first rendered AFTER the edit,
// so the ISR-cached detail page reflects the change (no stale cache from an earlier visit).
const threadEdit = await createThread(member, {
  title: 'E2E Edit Thread',
  question: '<p>Editable <strong>bold</strong> start</p>',
});
// A thread with a long https link, for the tidied-URL-display spec (render + reopen-in-editor).
const LONG_URL = 'https://desify.com.au/deals/view/abcdef1234567890/redeem-your-code-now-summer-2026';
const threadUrl = await createThread(member, {
  title: 'E2E URL Thread',
  question:
    `<p>Check <a href="${LONG_URL}" target="_blank" rel="noopener noreferrer">${LONG_URL}</a></p>`,
});
const threadLegacy = await createThread(member, {
  title: 'E2E Legacy Thread',
  question: 'Legacy line one.\nLegacy line two.',
});

// Threads landing SSR pre-fill (featureplans/threads-seo-landing.md): 13 threads so the default
// first page is a full 12 (AC2) and at least one 'E2E Landing Thread NN' card is on page 1 for the
// title+link check (AC1). Sequential create => distinct createdAt, so newest-first is stable.
for (let i = 1; i <= 13; i++) {
  await createThread(member, {
    title: `E2E Landing Thread ${String(i).padStart(2, '0')}`,
    question: `Seeded landing thread number ${i} for the SSR pre-fill test.`,
  });
}

// Seated events with cosmetic walkway gaps, for the walkways customer-map spec.
const walkwayLayout = (n, positions) => [{
  rowLabel: 'A',
  walkwayPositions: positions,
  seats: Array.from({ length: n }, (_, i) => ({ seatId: `A-${i + 1}`, seatNumber: String(i + 1), row: 'A', status: 'available' })),
}];
const walkwayEvent = await createPaidEvent(organiser, {
  title: 'E2E Walkway Fest', capacity: 40, maxAttendeesPerRegistration: 10, seatingLayout: walkwayLayout(40, [13, 26]),
});
const walkwayWideEvent = await createPaidEvent(organiser, {
  title: 'E2E Walkway Wide Fest', capacity: 40, maxAttendeesPerRegistration: 10, seatingLayout: walkwayLayout(40, [20]),
});

// A seated hall with one NOT-FOR-SALE seat (A-1 blocked) for events-blocked-seats.md AC2/AC6: the
// attendee map renders it greyed with an X and unclickable, and the shared legend shows "Not for sale".
const blockedSeatEvent = await createPaidEvent(organiser, {
  title: 'E2E Blocked Seat Fest', capacity: 10, maxAttendeesPerRegistration: 10,
  seatingLayout: [{
    rowLabel: 'A',
    walkwayPositions: [],
    seats: Array.from({ length: 10 }, (_, i) => ({
      seatId: `A-${i + 1}`, seatNumber: String(i + 1), row: 'A',
      status: i === 0 ? 'blocked' : 'available',
    })),
  }],
});

// A PAST event the organiser SOFT-deleted, for events-past-events.md AC1/AC4: it still renders publicly
// in the Past events section (with its card + image + "Ended" tag) but is gone from the organiser's
// manage list (/events/mine excludes soft-deleted). Past by date (expiryDate before now), goLive.
const pastEndedEvent = await createFreeEvent(organiser, {
  title: 'E2E Past Ended Fest',
  dateTime: new Date(Date.now() - 20 * 24 * 3600 * 1000),
  expiryDate: new Date(Date.now() - 10 * 24 * 3600 * 1000),
  images: [{ url: 'https://res.cloudinary.com/demo/image/upload/sample.jpg', publicId: 'past-ended-pid' }],
  deletedByOrganiser: true,
  deletedByOrganiserAt: new Date(Date.now() - 5 * 24 * 3600 * 1000),
  featuredInPast: true, // admin-featured, so it shows in the public Past strip
});

// A past event the admin has NOT featured - proves curation (it must NOT show in the public Past strip).
const pastUnfeaturedEvent = await createFreeEvent(organiser, {
  title: 'E2E Past Unfeatured Fest',
  dateTime: new Date(Date.now() - 18 * 24 * 3600 * 1000),
  expiryDate: new Date(Date.now() - 9 * 24 * 3600 * 1000),
});

// A horizontally-FLIPPED hall for events-layout-tools.md AC4/AC6: 5 seats, an aisle after seat 2, a
// reserved seat (A-1) and a not-for-sale seat (A-5), saved with seatingLayoutFlipH=true. The attendee
// map must render it reversed (A5..A1 left-to-right), with the aisle on the mirrored side.
const flippedSeatEvent = await createPaidEvent(organiser, {
  title: 'E2E Flipped Seat Fest', capacity: 5, maxAttendeesPerRegistration: 10,
  seatingLayoutFlipH: true,
  seatingLayout: [{
    rowLabel: 'A',
    walkwayPositions: [2],
    seats: Array.from({ length: 5 }, (_, i) => ({
      seatId: `A-${i + 1}`, seatNumber: String(i + 1), row: 'A',
      status: i === 0 ? 'reserved' : i === 4 ? 'blocked' : 'available',
    })),
  }],
});

// A large hall for the seat-map zoom spec: wide enough that the fitted view sits below the tap-size
// threshold (selection gated until zoomed in). Rows A-E x 80 seats.
const zoomHallSeats = (label, n) =>
  Array.from({ length: n }, (_, i) => ({ seatId: `${label}-${i + 1}`, seatNumber: String(i + 1), row: label, status: 'available' }));
const zoomHallEvent = await createPaidEvent(organiser, {
  title: 'E2E Zoom Hall', capacity: 400, maxAttendeesPerRegistration: 10,
  seatingLayout: ['A', 'B', 'C', 'D', 'E'].map((r) => ({ rowLabel: r, seats: zoomHallSeats(r, 80) })),
});

// Coupon campaign for the guest-claim spec (see featureplans/coupons-guest-code.md): an active,
// unrestricted campaign a logged-out visitor can claim by email from its public views page.
const couponStore = await createStore(organiser, {
  storeName: 'E2E Coupon Store',
  contactInfo: { phone: '0212345678', email: 'e2e-store@test.dev' },
});
const couponCampaign = await createCampaign(couponStore, organiser, {
  campaignName: 'E2E Coupon Campaign',
  slug: 'e2e-coupon-campaign',
  discount: '25% off',
  discountProduct: 'all items',
});

// Coupons landing SSR pre-fill (featureplans/coupons-seo-landing.md): the coupons browse
// paginates by STORE (20/page) and the grid shows all campaigns from the page's stores. Seed 21
// stores each with one active campaign so the default first page is a full 20 (AC2) and a page 2
// exists (AC8). Each campaign carries an 'e2e-landing-coupon-NN' slug (title+link check, AC1).
for (let i = 1; i <= 21; i++) {
  const nn = String(i).padStart(2, '0');
  const landingStore = await createStore(organiser, {
    storeName: `E2E Landing Coupon Store ${nn}`,
    contactInfo: { phone: '0212345678', email: `e2e-landing-store-${nn}@test.dev` },
  });
  await createCampaign(landingStore, organiser, {
    campaignName: `E2E Landing Coupon ${nn}`,
    slug: `e2e-landing-coupon-${nn}`,
    discount: 'Save 20%',
    discountProduct: `E2E Landing Coupon ${nn}`,
  });
}

// Discount-hint validity filter: a paid event owned by the known-credential organiser (so an
// owner-view gets the FULL, unfiltered discountCodes array) carrying a LIVE code and a used-up
// DEAD code. The customer-facing hint must show LIVE10 and hide DEAD10 (remainingUses 0).
const discountEvent = await createPaidEvent(builderOrganiser, {
  title: 'E2E Discount Fest',
  capacity: 50,
  ticketTypes: [{ name: 'Standard', price: 10 }],
  discountCodes: [
    { code: 'LIVE10', kind: 'percent', value: 10, active: true, showHint: true,
      appliesToTicketTypes: ['Standard'], remainingUses: 5, validUntil: new Date('2999-01-01') },
    { code: 'DEAD10', kind: 'percent', value: 10, active: true, showHint: true,
      appliesToTicketTypes: ['Standard'], remainingUses: 0 },
  ],
});

// Tickets-UI feature-plan spec (featureplans/events-tickets-ui.md). One general-admission event
// exercising the restructured tickets page: a row with a NOTE and a public discount hint (note must
// render before the discount), a ticket expiring in 3 days (amber "3 days left" badge), a ticket
// already expired (red "Sales closed" badge), and a REQUIRED attendee field (CTA disable/enable).
const ticketsUiNow = Date.now();
const ticketsUiEvent = await createPaidEvent(organiser, {
  title: 'E2E Tickets UI Fest', capacity: 50, maxAttendeesPerRegistration: 10,
  ticketTypes: [
    { name: 'General', price: 20, note: 'Includes welcome drink',
      expiryDate: new Date(ticketsUiNow + 3 * 24 * 3600 * 1000) },
    { name: 'EarlyBird', price: 15, expiryDate: new Date(ticketsUiNow - 24 * 3600 * 1000) },
  ],
  registrationFields: [{ fieldName: 'Full Name', fieldType: 'text', isRequired: true }],
  discountCodes: [
    { code: 'DRINK5', kind: 'fixed', value: 5, active: true, showHint: true,
      appliesToTicketTypes: ['General'], remainingUses: 5, validUntil: new Date('2999-01-01') },
  ],
});

// RSVP-UI feature-plan spec (featureplans/events-rsvp-ui.md). A free event with a REQUIRED custom
// question so the rsvpui suite can prove: the shared "Attendee Information" card renders the custom
// question (AC3), Register stays disabled until mobile + name + the required question are complete
// (AC2), and a member can still RSVP end to end under the new layout (AC4). Dedicated so it never
// collides with the events other RSVP specs register on.
const rsvpUiEvent = await createFreeEvent(organiser, {
  title: 'E2E RSVP UI Fest', capacity: 100, maxAttendeesPerRegistration: 5,
  registrationFields: [{ fieldName: 'Dietary needs', fieldType: 'text', isRequired: true }],
});

// RSVP question types (featureplans/events-rsvp-question-types.md). All owned by the known-credential
// organiser so organiser.json can edit them / open the check-in console.
// A question-free FREE event and a no-sales PAID event to edit-drive the step-3 builder (the add-menu
// offers eight types on free, only text + dropdown on paid). No activity, so questions stay editable.
const qtypesFreeEvent = await createFreeEvent(builderOrganiser, { title: 'E2E QTypes Free Builder', capacity: 100 });
const qtypesPaidEvent = await createPaidEvent(builderOrganiser, { title: 'E2E QTypes Paid Builder', capacity: 50 });

// A FREE event carrying the six currently-offered types (blocking multiple-choice, a labelled scale,
// and a date+time question), for the attendee 360px journey and the scale-tier check. No member
// registration yet, so member.json can RSVP it fresh.
const qtypesRsvpEvent = await createFreeEvent(builderOrganiser, {
  title: 'E2E QTypes Attendee', capacity: 100, maxAttendeesPerRegistration: 3,
  registrationFields: [
    { fieldName: 'Dietary needs', fieldType: 'text', isRequired: false },
    { fieldName: 'Are you 18 or over?', fieldType: 'radio', fieldOptions: ['Yes', 'No'], blockingOptions: ['No'], blockingMessage: 'Sorry, 18+ only.', isRequired: true },
    { fieldName: 'T-shirt size', fieldType: 'select', fieldOptions: ['S', 'M', 'L'], isRequired: false },
    { fieldName: 'Workshops', fieldType: 'checkboxes', fieldOptions: ['Painting', 'Dance', 'Music'], isRequired: false },
    { fieldName: 'Rate the venue', fieldType: 'scale', fieldOptions: ['Awful', '', '', '', 'Amazing'], isRequired: false },
    { fieldName: 'Arrival date', fieldType: 'date', includeTime: true, isRequired: false },
  ],
});

// A worst-case FREE event for the builder's visual verification: a 200-char label, a multiple-choice
// and a pick-many each with several 150-char options, plus scale/date/time/yes-no. Proves the RSVP
// form survives the ugliest realistic data at every tier (00-shared/frontend-visual-verification.md).
const LONG_OPT = (n) => `Choice ${n} - ` + 'x'.repeat(140);
const qtypesWorstEvent = await createFreeEvent(builderOrganiser, {
  title: 'E2E QTypes Worst Case', capacity: 100, maxAttendeesPerRegistration: 3,
  registrationFields: [
    { fieldName: 'Please describe in detail any dietary requirements, allergies, or access needs ' + 'that our catering and venue team should plan for '.repeat(2), fieldType: 'text', isRequired: true },
    { fieldName: 'Which single session best matches your interest for the main afternoon programme block ' + 'q'.repeat(110), fieldType: 'radio', fieldOptions: [LONG_OPT(1), LONG_OPT(2), LONG_OPT(3)], blockingOptions: [LONG_OPT(3)], blockingMessage: 'That session is full, so registration is closed for it.', isRequired: true },
    { fieldName: 'Select every optional workshop you would like to attend across the weekend ' + 'w'.repeat(100), fieldType: 'checkboxes', fieldOptions: [LONG_OPT('A'), LONG_OPT('B'), LONG_OPT('C'), LONG_OPT('D')], isRequired: false },
    { fieldName: 'On a scale of one to five how likely are you to recommend this festival to a friend ' + 'z'.repeat(90), fieldType: 'scale', fieldOptions: ['Would not rec.!', '', '', '', 'Would recommend'], isRequired: false },
    { fieldName: 'When will you arrive at the venue on the first day of the festival programme ' + 'd'.repeat(90), fieldType: 'date', includeTime: true, isRequired: true },
  ],
});

// A FREE event with questions + registrations (one carrying a pick-many list) for the CSV journey and
// the check-in answers sheet. Mobiles start 0 so the leading-zero handling can be proven.
const qtypesCsvEvent = await createFreeEvent(builderOrganiser, {
  title: 'E2E QTypes CSV', capacity: 100,
  registrationFields: [
    { fieldName: 'Dietary needs', fieldType: 'text', isRequired: false },
    { fieldName: 'Workshops', fieldType: 'checkboxes', fieldOptions: ['Painting', 'Dance', 'Music'], isRequired: false },
    { fieldName: 'T-shirt size', fieldType: 'select', fieldOptions: ['S', 'M', 'L'], isRequired: false },
    { fieldName: 'Arrival', fieldType: 'date', includeTime: true, isRequired: false },
  ],
});
await createFreeRegistration(qtypesCsvEvent, member, {
  registrationNumber: 'RC-CSV-01', mobile: '0412345678',
  attendees: [{ name: 'Casey Csv', checkedIn: false }],
  formResponses: [
    { fieldName: 'Dietary needs', response: 'Vegetarian' },
    { fieldName: 'Workshops', response: ['Painting', 'Music'] },
    { fieldName: 'T-shirt size', response: 'M' },
    { fieldName: 'Arrival', response: '2026-08-20T14:30' },
  ],
});
await createFreeRegistration(qtypesCsvEvent, member, {
  registrationNumber: 'RC-CSV-02', mobile: '0498765432', email: 'qtypes-csv-2@test.dev',
  attendees: [{ name: 'Drew Csv', checkedIn: false }],
  formResponses: [{ fieldName: 'Workshops', response: ['Dance'] }],
});

// RSVP question editing (events-rsvp-question-editing.md). Owned by the known-credential organiser so
// organiser.json can edit them; questions carry stable qids and the event has activity, so the builder
// shows the post-activity edit rules: a FREE event opens label-safe edits, a PAID event stays frozen.
const qeditFreeEvent = await createFreeEvent(builderOrganiser, {
  title: 'E2E QEdit Free', capacity: 100, hasActivity: true,
  registrationFields: [
    { qid: 'qe-meal', fieldName: 'Meal choice', fieldType: 'select', fieldOptions: ['Veg', 'Non-veg'], isRequired: false, includeTime: false, blockingOptions: [], blockingMessage: '' },
    { qid: 'qe-rate', fieldName: 'Rate the venue', fieldType: 'scale', fieldOptions: ['Poor', '', '', '', 'Great'], isRequired: false, includeTime: false, blockingOptions: [], blockingMessage: '' },
  ],
});
const qeditPaidEvent = await createPaidEvent(builderOrganiser, {
  title: 'E2E QEdit Paid', capacity: 50, hasActivity: true,
  registrationFields: [
    { qid: 'qe-notes', fieldName: 'Notes', fieldType: 'text', fieldOptions: [], isRequired: false, includeTime: false, blockingOptions: [], blockingMessage: '' },
  ],
});

// A FREE event with three questions and NO activity, dedicated to the reorder (move up/down) test:
// the builder can reorder freely and the new order must survive a save.
const qreorderFreeEvent = await createFreeEvent(builderOrganiser, {
  title: 'E2E QReorder Free', capacity: 100,
  registrationFields: [
    { qid: 'qr-size', fieldName: 'T-shirt size', fieldType: 'select', fieldOptions: ['S', 'M', 'L'], isRequired: false },
    { qid: 'qr-diet', fieldName: 'Any dietary needs', fieldType: 'text', isRequired: false },
    { qid: 'qr-age', fieldName: 'Are you 18 or over', fieldType: 'radio', fieldOptions: ['Yes', 'No'], isRequired: false },
  ],
});

// RSVP check-in redesign (featureplans/events-rsvp-checkin-redesign.md). Free events owned by the
// known-credential organiser (so organiser.json can open the /checkinrsvp console), each seeded with
// fixed-reg-number bookings in known check-in states. An ACTIVE event (mixed states, one attendee
// named "Zara" for the search test, enough rows to scroll), a PAST-dated event (Active/Past split),
// and an INTERACT event whose bookings each isolate one interaction (single toggle, party-of-3 sheet,
// with-answers info icon, cancellable, already-done).
const rsvpCheckinActiveEvent = await createFreeEvent(builderOrganiser, { title: 'E2E RSVP Checkin Active', capacity: 100 });
await createFreeRegistration(rsvpCheckinActiveEvent, member, { registrationNumber: 'RC-A01', attendees: [{ name: 'Ann Alpha', checkedIn: true, checkInTime: new Date() }] });
await createFreeRegistration(rsvpCheckinActiveEvent, member, { registrationNumber: 'RC-A02', attendees: [{ name: 'Bea Beta', checkedIn: true, checkInTime: new Date() }, { name: 'Ben Beta', checkedIn: true, checkInTime: new Date() }] });
await createFreeRegistration(rsvpCheckinActiveEvent, member, { registrationNumber: 'RC-A03', attendees: [{ name: 'Cy Gamma', checkedIn: true, checkInTime: new Date() }, { name: 'Cara Gamma', checkedIn: false }] });
await createFreeRegistration(rsvpCheckinActiveEvent, member, { registrationNumber: 'RC-A04', attendees: [{ name: 'Zara Searchtarget', checkedIn: false }] });
for (let i = 5; i <= 16; i++) {
  const n = String(i).padStart(2, '0');
  await createFreeRegistration(rsvpCheckinActiveEvent, member, { registrationNumber: `RC-A${n}`, attendees: [{ name: `Filler Guest ${n}`, checkedIn: false }] });
}

// A high-volume event (100 RSVPs) to prove the per-event console stays usable at scale - all rows
// render, the page scrolls, and the search + tabs stay pinned so an organiser can still narrow down.
const rsvpCheckinVolumeEvent = await createFreeEvent(builderOrganiser, { title: 'E2E RSVP Checkin Volume', capacity: 1000 });
await Promise.all(Array.from({ length: 100 }, (_, k) => {
  const n = String(k + 1).padStart(3, '0');
  return createFreeRegistration(rsvpCheckinVolumeEvent, member, {
    registrationNumber: `RC-V-${n}`,
    attendees: [{ name: `Volume Guest ${n}`, checkedIn: (k + 1) % 3 === 0 }],
  });
}));

const rsvpCheckinPastEvent = await createFreeEvent(builderOrganiser, {
  title: 'E2E RSVP Checkin Past',
  dateTime: new Date(Date.now() - 14 * 24 * 3600 * 1000),
  expiryDate: new Date(Date.now() - 7 * 24 * 3600 * 1000),
});
await createFreeRegistration(rsvpCheckinPastEvent, member, { registrationNumber: 'RC-P01', attendees: [{ name: 'Past Guest', checkedIn: false }] });

const rsvpCheckinInteractEvent = await createFreeEvent(builderOrganiser, { title: 'E2E RSVP Checkin Interact', capacity: 100 });
await createFreeRegistration(rsvpCheckinInteractEvent, member, { registrationNumber: 'RC-I-SINGLE', attendees: [{ name: 'Solo Single', checkedIn: false }] });
await createFreeRegistration(rsvpCheckinInteractEvent, member, { registrationNumber: 'RC-I-PARTY', attendees: [{ name: 'Party One', checkedIn: false }, { name: 'Party Two', checkedIn: false }, { name: 'Party Three', checkedIn: false }] });
await createFreeRegistration(rsvpCheckinInteractEvent, member, { registrationNumber: 'RC-I-INFO', attendees: [{ name: 'Info Guest', checkedIn: false }], formResponses: [{ fieldName: 'Dietary needs', response: 'Vegetarian' }] });
await createFreeRegistration(rsvpCheckinInteractEvent, member, { registrationNumber: 'RC-I-CANCEL', attendees: [{ name: 'Cancel Guest', checkedIn: false }] });
await createFreeRegistration(rsvpCheckinInteractEvent, member, { registrationNumber: 'RC-I-DONE', attendees: [{ name: 'Done Guest', checkedIn: true, checkInTime: new Date() }] });
// A GUEST booking: the guest account name is the 'Guest' placeholder, so "Booked by" must fall back
// to the email they gave (not print the bare word "Guest").
const rsvpCheckinGuestUser = await createUser({ role: 'guest', name: 'Guest', email: 'guest-booking@test.dev' });
await createFreeRegistration(rsvpCheckinInteractEvent, rsvpCheckinGuestUser, { registrationNumber: 'RC-I-GUEST', email: 'guest-booking@test.dev', attendees: [{ name: 'Walk In Attendee', checkedIn: false }] });
// Worst-case fixture (events-rsvp-checkin-redesign feel-pass): the longest realistic reg number, a
// very long booker name, and a large party (8) - so the 3-tier verification proves the Reg Number is
// never clipped and the page never scrolls sideways at 360 / 768 / 1280.
const rsvpCheckinLongNameUser = await createUser({ email: 'e2e-longname@test.dev', name: 'Bartholomew Alexander Featherstonehaugh Fauntleroy-Cholmondeley' });
await createFreeRegistration(rsvpCheckinInteractEvent, rsvpCheckinLongNameUser, {
  registrationNumber: 'REG-VERYLONGEVENTCODE-2264-00000001',
  attendees: Array.from({ length: 8 }, (_, i) => ({ name: `Attendee Number ${i + 1}`, checkedIn: false })),
  formResponses: [
    { fieldName: 'Dietary requirements and access needs', response: 'Two of our party are strictly vegetarian, one is coeliac and needs gluten-free options, and one uses a wheelchair so we will need step-free access to the seating and a table near the accessible entrance if at all possible. Thank you very much for accommodating us.' },
    { fieldName: 'How did you hear about this event?', response: 'Through the community WhatsApp group and then again from a friend who attended last year.' },
  ],
});

// PAID check-in redesign (featureplans/events-paid-checkin-redesign.md). Paid events owned by the
// known-credential organiser, with PaidTickets grouped into invoices in known states: single-ticket
// (direct toggle), multi-ticket (sheet), fully-checked (Done), with-answers (info), and a cancelled
// ticket (hidden from the list, counted in the Cancelled stat). Plus a PAST paid event for the split.
const checkinPaidActiveEvent = await createPaidEvent(builderOrganiser, { title: 'E2E Paid Checkin Active', capacity: 100 });
const paidBuyer = (first, last) => ({ firstName: first, lastName: last, email: `${first.toLowerCase()}@buyer.test`, agreedToTerms: true });
// INV-PAID-1: one ticket, not checked in (direct toggle; Pending).
await createPaidTicket(checkinPaidActiveEvent, member, { invoiceNumber: 'INV-PAID-1', ticketNumber: 'TKT-P1A', buyer: paidBuyer('Alan', 'Active'), attendees: [{ name: 'Alan Active', checkedIn: false }] });
// INV-PAID-2: two tickets, not checked in (opens sheet; Pending). Buyer "Zara" for the search test.
await createPaidTicket(checkinPaidActiveEvent, member, { invoiceNumber: 'INV-PAID-2', ticketNumber: 'TKT-P2A', buyer: paidBuyer('Zara', 'Buyer'), attendees: [{ name: 'Zara Buyer', checkedIn: false }] });
await createPaidTicket(checkinPaidActiveEvent, member, { invoiceNumber: 'INV-PAID-2', ticketNumber: 'TKT-P2B', buyer: paidBuyer('Zara', 'Buyer'), attendees: [{ name: 'Zara Buyer', checkedIn: false }] });
// INV-PAID-3: two tickets, both checked in (Done).
await createPaidTicket(checkinPaidActiveEvent, member, { invoiceNumber: 'INV-PAID-3', ticketNumber: 'TKT-P3A', checkInStatus: 'checked-in', buyer: paidBuyer('Dan', 'Done'), attendees: [{ name: 'Dan Done', checkedIn: true, checkInTime: new Date() }] });
await createPaidTicket(checkinPaidActiveEvent, member, { invoiceNumber: 'INV-PAID-3', ticketNumber: 'TKT-P3B', checkInStatus: 'checked-in', buyer: paidBuyer('Dan', 'Done'), attendees: [{ name: 'Dan Done', checkedIn: true, checkInTime: new Date() }] });
// INV-PAID-4: one ticket with order answers (info icon -> Attendee Info).
await createPaidTicket(checkinPaidActiveEvent, member, { invoiceNumber: 'INV-PAID-4', ticketNumber: 'TKT-P4A', buyer: paidBuyer('Ivy', 'Info'), attendees: [{ name: 'Ivy Info', checkedIn: false }], formResponses: [{ fieldName: 'Dietary requirements', response: 'Vegan; no nuts' }] });
// INV-PAID-CANCELLED: one cancelled ticket - hidden from the list, counted in the Cancelled stat.
await createPaidTicket(checkinPaidActiveEvent, member, { invoiceNumber: 'INV-PAID-CANCELLED', ticketNumber: 'TKT-P5A', checkInStatus: 'cancelled', buyer: paidBuyer('Cara', 'Cancelled'), attendees: [{ name: 'Cara Cancelled', checkedIn: false }] });

// Worst-case order for the 3-tier visual check: longest invoice number, long buyer + email, 8 tickets.
const paidLongBuyer = { firstName: 'Bartholomew Alexander', lastName: 'Featherstonehaugh-Cholmondeley', email: 'bartholomew.featherstonehaugh@averylongdomainname.example', agreedToTerms: true };
for (let i = 1; i <= 8; i++) {
  await createPaidTicket(checkinPaidActiveEvent, member, {
    invoiceNumber: 'INV-PAID-VERYLONGINVOICENUMBER-000001',
    ticketNumber: `TKT-PLONG-${String(i).padStart(2, '0')}`,
    buyer: paidLongBuyer,
    ticketType: { name: 'General Admission', price: 20 },
    attendees: [{ name: `Guest ${i}`, checkedIn: false }],
  });
}

const checkinPaidPastEvent = await createPaidEvent(builderOrganiser, {
  title: 'E2E Paid Checkin Past',
  dateTime: new Date(Date.now() - 14 * 24 * 3600 * 1000),
  expiryDate: new Date(Date.now() - 7 * 24 * 3600 * 1000),
});
await createPaidTicket(checkinPaidPastEvent, member, { invoiceNumber: 'INV-PAID-PAST', ticketNumber: 'TKT-PAST', buyer: paidBuyer('Pat', 'Past'), attendees: [{ name: 'Pat Past', checkedIn: false }] });

// Events detail SEO (featureplans/events-seo-detail.md). A fixed Willetton/WA address + a fixed
// future date so the generated one-liner description is deterministic in the specs.
const SEO_ADDRESS = {
  formattedAddress: '1 Temple Rd, Willetton WA 6155',
  suburb: 'Willetton', state: 'WA',
  location: { type: 'Point', coordinates: [115.8878, -32.0489] },
};
const SEO_DATE = new Date('2026-09-14T12:00:00Z'); // formats to "14 Sep 2026"
// Both SEO fields set: drives the exact-title (AC3) and exact-description (AC6) checks.
const SEO_FULL_TITLE = 'TAP Vinayaka Pooja in Perth';
const SEO_FULL_DESCRIPTION =
  'Join the TAP Vinayaka Pooja in Perth on 14 Sep - a free community celebration with bhajans, prasadam and cultural programs for all.';
const seoFullEvent = await createFreeEvent(organiser, {
  title: 'Vinayaka Pooja (organiser title)',
  address: SEO_ADDRESS, dateTime: SEO_DATE,
  seoTitle: SEO_FULL_TITLE, seoDescription: SEO_FULL_DESCRIPTION,
});
// No SEO fields: title falls back to the organiser title (AC4/AC5), description to the generated
// free-event one-liner ending "Free RSVP." (AC7).
const seoFreeEvent = await createFreeEvent(organiser, {
  title: 'SEO Free Event', address: SEO_ADDRESS, dateTime: SEO_DATE,
});
// No SEO fields, paid: generated one-liner ends "Get tickets." (AC8).
const seoPaidEvent = await createPaidEvent(organiser, {
  title: 'SEO Paid Event', address: SEO_ADDRESS, dateTime: SEO_DATE,
});
// A 1-word description: the 5-word gate fails -> level-3 CTA (fix-shared-seo-metadata.md AC7).
const seoNoDescEvent = await createFreeEvent(organiser, {
  title: 'SEO No Desc Event', address: SEO_ADDRESS, dateTime: SEO_DATE,
  description: 'Short.',
});

// A very long title so the generated one-liner exceeds ~155 chars - proves the cap (AC9).
const SEO_LONG_TITLE =
  'A Very Long Community Event Title That Keeps Going On And On Well Beyond Any Reasonable Length So The Generated Description Must Be Truncated To The Ceiling';
const seoLongEvent = await createFreeEvent(organiser, {
  title: SEO_LONG_TITLE, address: SEO_ADDRESS, dateTime: SEO_DATE,
});
// Events landing SSR pre-fill (featureplans/events-seo-landing.md): a guaranteed-soonest
// upcoming event so the default first page deterministically includes it (AC1/AC2).
const landingSoonestEvent = await createFreeEvent(organiser, {
  title: 'E2E Landing Soonest Fest',
  dateTime: new Date(Date.now() + 60 * 60 * 1000),
});

// Canonical grouping (featureplans/events-seo-canonical.md): a hero event and a "day" event
// that canonicals to it, so the day page's <link rel="canonical"> points at the hero (AC4),
// the hero self-canonicals (AC5), and the day page is not noindex (AC6).
const seoCanonHero = await createFreeEvent(organiser, {
  title: 'SEO Canonical Hero', address: SEO_ADDRESS, dateTime: SEO_DATE,
});
const seoCanonDay = await createFreeEvent(organiser, {
  title: 'SEO Canonical Day 1', address: SEO_ADDRESS, dateTime: SEO_DATE,
  seoCanonicalEventId: seoCanonHero._id,
});

// Shared SEO plumbing (featureplans/shared-seo-plumbing.md): one ACTIVE deal (with its partner
// store) so the deals sitemap lists a /deals/{title}-{id} URL (AC2) and the deals slug page +
// legacy /views page resolve; one ACTIVE listing so the listings slug page resolves (AC6).
const seoPartnerStore = await createPartnerStore(organiser, { businessName: 'E2E SEO Deals Store' });
const seoDeal = await createDeal(seoPartnerStore, organiser, { dealTitle: 'E2E SEO Deal' });

// Deals landing SSR pre-fill (featureplans/deals-seo-landing.md): 13 active deals so the default
// first page is a full 12 (AC2) and at least one 'E2E Landing Deal NN' card is on page 1 for the
// title+link check (AC1). Sequential create => distinct createdAt, so newest-first is stable.
for (let i = 1; i <= 13; i++) {
  await createDeal(seoPartnerStore, organiser, { dealTitle: `E2E Landing Deal ${String(i).padStart(2, '0')}` });
}
const seoListing = await createAdvert(organiser, { title: 'E2E SEO Listing' });

// Listings landing SSR pre-fill (featureplans/listings-seo-landing.md): 13 active listings so the
// default first page is a full 12 (AC2) and at least one 'E2E Landing Listing NN' card is on page 1
// for the title+link check (AC1). Sequential create => distinct createdAt, so newest-first is stable.
for (let i = 1; i <= 13; i++) {
  await createAdvert(organiser, { title: `E2E Landing Listing ${String(i).padStart(2, '0')}` });
}

// Side-rail banner ads (LEFT + RIGHT), national + active, so the layout-tiers spec can prove
// the ad rails are desktop-only (they render on lg+ once an ad is servable).
await createBannerRailAd('LEFT');
await createBannerRailAd('RIGHT');

// Sales-cutoff spec (fix-events-sales-cutoff.md AC8/AC9): a paid event whose sales window
// has passed (dateTime 2 days ago, expiryDate still in the future so it is not "past" yet).
const salesCutoffEvent = await createPaidEvent(organiser, {
  title: 'E2E Sales Closed Fest',
  dateTime: new Date(Date.now() - 2 * 24 * 3600 * 1000),
  timeZone: 'UTC',
  expiryDate: new Date(Date.now() + 5 * 24 * 3600 * 1000),
  capacity: 100,
  ticketTypes: [{ name: 'Standard', price: 20 }],
});

// events-past-offline-curation.md AC6/AC7: a FINISHED FREE event that is OFFLINE (goLive:false) and
// admin-featured - proves an offline event still qualifies for curation/the public strip, and that
// its RSVP shows a greyed "Registrations Closed" button once opened from the strip (it has ended).
const pastOfflineFreeEvent = await createFreeEvent(organiser, {
  title: 'E2E Past Offline Fest',
  dateTime: new Date(Date.now() - 20 * 24 * 3600 * 1000),
  expiryDate: new Date(Date.now() - 10 * 24 * 3600 * 1000),
  timeZone: 'Australia/Sydney',
  goLive: false,
  featuredInPast: true,
  images: [{ url: 'https://res.cloudinary.com/demo/image/upload/sample.jpg', publicId: 'past-offline-pid' }],
});

// events-past-offline-curation.md AC8: a FINISHED PAID event, admin-featured, proving the strip's own
// path also shows the existing "Sales Closed" state once opened.
const pastFeaturedPaidEvent = await createPaidEvent(organiser, {
  title: 'E2E Past Featured Paid Fest',
  dateTime: new Date(Date.now() - 20 * 24 * 3600 * 1000),
  expiryDate: new Date(Date.now() - 10 * 24 * 3600 * 1000),
  timeZone: 'Australia/Sydney',
  featuredInPast: true,
  images: [{ url: 'https://res.cloudinary.com/demo/image/upload/sample.jpg', publicId: 'past-paid-featured-pid' }],
});

// events-delete-retention.md AC9: an UPCOMING free event already moderation-blocked at seed time
// (set directly, mirroring how other "already in state X" fixtures are seeded) - its public page
// must read unavailable with no Register button.
const blockedDetailEvent = await createFreeEvent(organiser, {
  title: 'E2E Blocked Detail Fest',
  isBlocked: true,
  blockedAt: new Date(),
  blockedBy: adminUser._id,
});

// events-delete-retention.md AC10: a dedicated UPCOMING free event for the renewals-page
// Moderation Hide journey. expiryDate is forced to the epoch so it always sorts first (the
// renewals list sorts ascending by expiryDate) - guaranteed visible on page 1 regardless of what
// else is seeded, with no pagination click needed.
const renewalsModerationEvent = await createFreeEvent(organiser, {
  title: 'E2E Renewals Moderation Fest',
  expiryDate: new Date(0),
});

console.log('SEED_JSON=' + JSON.stringify({
  memberEmail: 'e2e-member@test.dev',
  memberPassword: 'test1234',
  organiserId: String(organiser._id),
  freeEventId: String(freeEvent._id),
  paidEventId: String(paidEvent._id),
  termsEventId: String(termsEvent._id),
  threadRichId: String(threadRich._id),
  threadEditId: String(threadEdit._id),
  threadUrlId: String(threadUrl._id),
  threadLegacyId: String(threadLegacy._id),
  walkwayEventId: String(walkwayEvent._id),
  walkwayWideEventId: String(walkwayWideEvent._id),
  zoomHallEventId: String(zoomHallEvent._id),
  blockedSeatEventId: String(blockedSeatEvent._id),
  flippedSeatEventId: String(flippedSeatEvent._id),
  pastEndedEventId: String(pastEndedEvent._id),
  pastUnfeaturedEventId: String(pastUnfeaturedEvent._id),
  organiserEmail: 'e2e-organiser@test.dev',
  organiserPassword: 'test1234',
  builderEmptyEventId: String(builderEmptyEvent._id),
  builderSoldEventId: String(builderSoldEvent._id),
  builderParityEventId: String(builderParityEvent._id),
  noRefundEventId: String(noRefundEvent._id),
  editLockSoldEventId: String(editLockSoldEvent._id),
  editLockQuestionEventId: String(editLockQuestionEvent._id),
  editLockCapacityEventId: String(editLockCapacityEvent._id),
  editLockStoppedEventId: String(editLockStoppedEvent._id),
  blockingRsvpEventId: String(blockingRsvpEvent._id),
  orgPageSlug: 'sydney-events-co',
  orgPageName: ORG_PAGE_NAME,
  orgEmptySlug: 'quiet-organiser',
  orgShareSlug: 'aurora-share-co',
  orgShareTitle: ORG_SHARE_TITLE,
  orgShareDescription: ORG_SHARE_DESCRIPTION,
  orgShareImage: ORG_SHARE_IMAGE,
  bundleEventId: String(bundleEvent._id),
  bundleClampEventId: String(bundleClampEvent._id),
  bundleTightEventId: String(bundleTightEvent._id),
  bundleRestoreEventId: String(bundleRestoreEvent._id),
  bundleRestoreSeatedEventId: String(bundleRestoreSeatedEvent._id),
  packPricingEventId: String(packPricingEvent._id),
  packPricingSeatedEventId: String(packPricingSeatedEvent._id),
  seatSyncEventId: String(seatSyncEvent._id),
  couponCampaignId: String(couponCampaign._id),
  couponCampaignSlug: 'e2e-coupon-campaign',
  seoFullEventId: String(seoFullEvent._id),
  seoFullEventTitle: SEO_FULL_TITLE,
  seoFullEventDescription: SEO_FULL_DESCRIPTION,
  seoFreeEventId: String(seoFreeEvent._id),
  seoFreeEventTitle: 'SEO Free Event',
  seoPaidEventId: String(seoPaidEvent._id),
  seoPaidEventTitle: 'SEO Paid Event',
  seoLongEventId: String(seoLongEvent._id),
  seoNoDescEventId: String(seoNoDescEvent._id),
  seoCanonHeroId: String(seoCanonHero._id),
  seoCanonHeroTitle: 'SEO Canonical Hero',
  seoCanonDayId: String(seoCanonDay._id),
  landingSoonestEventId: String(landingSoonestEvent._id),
  landingSoonestTitle: 'E2E Landing Soonest Fest',
  seoDealId: String(seoDeal._id),
  seoDealTitle: 'E2E SEO Deal',
  seoListingId: String(seoListing._id),
  seoListingTitle: 'E2E SEO Listing',
  threadRichTitle: 'E2E Rich Thread',
  freeEventTitle: 'E2E Free Fest',
  discountEventId: String(discountEvent._id),
  ticketsUiEventId: String(ticketsUiEvent._id),
  rsvpUiEventId: String(rsvpUiEvent._id),
  qtypesFreeEventId: String(qtypesFreeEvent._id),
  qtypesPaidEventId: String(qtypesPaidEvent._id),
  qtypesRsvpEventId: String(qtypesRsvpEvent._id),
  qtypesWorstEventId: String(qtypesWorstEvent._id),
  qtypesCsvEventId: String(qtypesCsvEvent._id),
  qeditFreeEventId: String(qeditFreeEvent._id),
  qreorderFreeEventId: String(qreorderFreeEvent._id),
  qeditPaidEventId: String(qeditPaidEvent._id),
  salesCutoffEventId: String(salesCutoffEvent._id),
  pastOfflineFreeEventId: String(pastOfflineFreeEvent._id),
  pastFeaturedPaidEventId: String(pastFeaturedPaidEvent._id),
  adminEmail: 'e2e-admin@test.dev',
  adminPassword: 'test1234',
  blockedDetailEventId: String(blockedDetailEvent._id),
  renewalsModerationEventId: String(renewalsModerationEvent._id),
  rsvpCheckinActiveEventId: String(rsvpCheckinActiveEvent._id),
  rsvpCheckinPastEventId: String(rsvpCheckinPastEvent._id),
  rsvpCheckinInteractEventId: String(rsvpCheckinInteractEvent._id),
  rsvpCheckinVolumeEventId: String(rsvpCheckinVolumeEvent._id),
  checkinPaidActiveEventId: String(checkinPaidActiveEvent._id),
  checkinPaidPastEventId: String(checkinPaidPastEvent._id),
}));

await mongoose.disconnect();
process.exit(0);
