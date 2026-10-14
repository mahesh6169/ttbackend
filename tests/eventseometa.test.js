// Plan: featureplans/events-seo-detail.md - AC1, AC2 (the SEO fields survive the views endpoint).
import request from 'supertest';
import app from '../app.js';
import { createOrganiser, createFreeEvent, API_KEY } from './helpers/factories.js';

const viewEvent = (id) =>
  request(app).get(`/api/events/views/${id}`).set('x-api-key', API_KEY);

test('AC1 an event with seoTitle and seoDescription set returns both stored values', async () => {
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
});

test('AC2 an event with neither field set still succeeds with the two fields absent', async () => {
  const organiser = await createOrganiser();
  const event = await createFreeEvent(organiser);

  const res = await viewEvent(event._id);
  expect(res.status).toBe(200);
  // No server-side default injected - the fields are simply absent (or empty).
  expect(res.body.seoTitle == null || res.body.seoTitle === '').toBe(true);
  expect(res.body.seoDescription == null || res.body.seoDescription === '').toBe(true);
});
