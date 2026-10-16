// Event SEO fields on the event detail (views) endpoint - see featureplans/events-seo-detail.md and
// events-seo-canonical.md. Stored seoTitle/seoDescription come back as set (and absent when unset);
// seoCanonicalEventId resolves to the hero event's URL, and to nothing when that hero is gone.
import mongoose from 'mongoose';
import { createOrganiser, createFreeEvent } from '../helpers/factories.js';
import { viewEvent } from '../helpers/eventRequests.js';
import { generateSlug } from '../../utils/helpers/shared/generateSlug.js';

const siteUrl = process.env.WEBSITE_URL || 'https://desify.com.au';

test('an event returns its SEO title and description when set, and nothing when not', async () => {
  const organiser = await createOrganiser();
  const event = await createFreeEvent(organiser, {
    seoTitle: 'TAP Vinayaka Pooja in Perth',
    seoDescription: 'Join the TAP Vinayaka Pooja in Perth - a free community celebration for all.',
  });

  const res = await viewEvent(event._id);
  expect(res.status).toBe(200);
  expect(res.body.seoTitle).toBe('TAP Vinayaka Pooja in Perth');
  expect(res.body.seoDescription).toBe(
    'Join the TAP Vinayaka Pooja in Perth - a free community celebration for all.'
  );

  // Without the fields the request still succeeds, with no server-side default injected.
  const plain = await createFreeEvent(organiser);
  const plainRes = await viewEvent(plain._id);
  expect(plainRes.status).toBe(200);
  expect(plainRes.body.seoTitle == null || plainRes.body.seoTitle === '').toBe(true);
  expect(plainRes.body.seoDescription == null || plainRes.body.seoDescription === '').toBe(true);
});

test('an event pointing at a hero event returns the hero\'s URL as its canonical URL', async () => {
  const organiser = await createOrganiser();
  const hero = await createFreeEvent(organiser, { title: 'TAP Vinayaka Pooja Grand Finale' });
  const day = await createFreeEvent(organiser, { title: 'Day 1 TAP Vinayaka Pooja', seoCanonicalEventId: hero._id });

  const res = await viewEvent(day._id);
  expect(res.status).toBe(200);
  expect(res.body.seoCanonicalUrl).toBe(
    `${siteUrl}/events/${generateSlug(hero.title)}-${hero._id}`
  );
});

test('an event with no hero has no canonical URL (it is its own canonical)', async () => {
  const organiser = await createOrganiser();
  const event = await createFreeEvent(organiser);

  const res = await viewEvent(event._id);
  expect(res.status).toBe(200);
  expect(res.body.seoCanonicalUrl).toBeUndefined();
});

test('a hero that does not exist gives no canonical URL', async () => {
  const organiser = await createOrganiser();
  const missingId = new mongoose.Types.ObjectId(); // never created
  const day = await createFreeEvent(organiser, { title: 'Orphan Day', seoCanonicalEventId: missingId });

  const res = await viewEvent(day._id);
  expect(res.status).toBe(200);
  expect(res.body.seoCanonicalUrl).toBeUndefined();
});

test('a hero the organiser deleted gives no canonical URL', async () => {
  const organiser = await createOrganiser();
  const deletedHero = await createFreeEvent(organiser, { title: 'Retired Hero', deletedByOrganiser: true });
  const day = await createFreeEvent(organiser, { title: 'Day Of Retired', seoCanonicalEventId: deletedHero._id });

  const res = await viewEvent(day._id);
  expect(res.status).toBe(200);
  expect(res.body.seoCanonicalUrl).toBeUndefined();
});
