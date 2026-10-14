// Plan: featureplans/events-seo-canonical.md - AC1..AC3 (resolve seoCanonicalEventId to a URL).
import mongoose from 'mongoose';
import request from 'supertest';
import app from '../app.js';
import { createOrganiser, createFreeEvent, API_KEY } from './helpers/factories.js';
import { generateSlug } from '../utils/helpers/shared/generateSlug.js';

const viewEvent = (id) =>
  request(app).get(`/api/events/views/${id}`).set('x-api-key', API_KEY);

const siteUrl = process.env.WEBSITE_URL || 'https://desify.com.au';

test('AC1 an event pointing at a hero returns the hero URL as seoCanonicalUrl', async () => {
  const organiser = await createOrganiser();
  const hero = await createFreeEvent(organiser, { title: 'TAP Vinayaka Pooja Grand Finale' });
  const day = await createFreeEvent(organiser, { title: 'Day 1 TAP Vinayaka Pooja', seoCanonicalEventId: hero._id });

  const res = await viewEvent(day._id);
  expect(res.status).toBe(200);
  expect(res.body.seoCanonicalUrl).toBe(
    `${siteUrl}/events/${generateSlug(hero.title)}-${hero._id}`
  );
});

test('AC2 an event with no seoCanonicalEventId has no seoCanonicalUrl (self-canonical)', async () => {
  const organiser = await createOrganiser();
  const event = await createFreeEvent(organiser);

  const res = await viewEvent(event._id);
  expect(res.status).toBe(200);
  expect(res.body.seoCanonicalUrl).toBeUndefined();
});

test('AC3 a seoCanonicalEventId pointing at a non-existent event yields no seoCanonicalUrl', async () => {
  const organiser = await createOrganiser();
  const missingId = new mongoose.Types.ObjectId(); // never created
  const day = await createFreeEvent(organiser, { title: 'Orphan Day', seoCanonicalEventId: missingId });

  const res = await viewEvent(day._id);
  expect(res.status).toBe(200);
  expect(res.body.seoCanonicalUrl).toBeUndefined();
});

test('AC3 a seoCanonicalEventId pointing at a soft-deleted hero yields no seoCanonicalUrl', async () => {
  const organiser = await createOrganiser();
  const deletedHero = await createFreeEvent(organiser, { title: 'Retired Hero', deletedByOrganiser: true });
  const day = await createFreeEvent(organiser, { title: 'Day Of Retired', seoCanonicalEventId: deletedHero._id });

  const res = await viewEvent(day._id);
  expect(res.status).toBe(200);
  expect(res.body.seoCanonicalUrl).toBeUndefined();
});
