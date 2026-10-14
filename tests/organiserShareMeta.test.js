// Organiser page share card - see featureplans/events-organiser-share-meta.md.
// GET /events/by/:slug also returns the organiser's three optional share fields (empty when unset,
// the exact set values when present) alongside organiserName + events. The share card itself is
// built on the frontend from these fields; the browser suite (organiserShareMeta.spec.js) proves
// the rendered head.
import request from 'supertest';
import app from '../app.js';
import {
  createOrganiser, createFreeEvent, API_KEY,
} from './helpers/factories.js';

const byOrg = (slug) => request(app).get(`/api/events/by/${slug}`).set('x-api-key', API_KEY);

test('AC1 an organiser with no share fields returns them empty, alongside organiserName + events', async () => {
  const org = await createOrganiser({ email: 'share-none@test.dev', slug: 'share-none' });
  await createFreeEvent(org, { title: 'Share None Fest', organizer: { name: 'Share None Co', contact: '0412345678' } });

  const res = await byOrg('share-none');
  expect(res.status).toBe(200);
  expect(res.body.organiserName).toBe('Share None Co');
  expect(Array.isArray(res.body.events)).toBe(true);
  // Unset share fields come back empty/falsy.
  expect(res.body.organiserShareTitle).toBeFalsy();
  expect(res.body.organiserShareDescription).toBeFalsy();
  expect(res.body.organiserShareImage).toBeFalsy();
});

test('AC2 an organiser with the three share fields set returns those exact values', async () => {
  const org = await createOrganiser({
    email: 'share-set@test.dev',
    slug: 'share-set',
    organiserShareTitle: 'Diwali Nights by Aurora Events',
    organiserShareDescription: 'Book your Diwali tickets before they sell out!',
    organiserShareImage: 'https://cdn.example.com/aurora-share.jpg',
  });
  await createFreeEvent(org, { title: 'Share Set Fest', organizer: { name: 'Aurora Events', contact: '0412345678' } });

  const res = await byOrg('share-set');
  expect(res.status).toBe(200);
  expect(res.body.organiserShareTitle).toBe('Diwali Nights by Aurora Events');
  expect(res.body.organiserShareDescription).toBe('Book your Diwali tickets before they sell out!');
  expect(res.body.organiserShareImage).toBe('https://cdn.example.com/aurora-share.jpg');
  // organiserShareTitle is the authoritative display name: it wins over the event's own
  // organizer.name ('Aurora Events'), so the page heading reads from the share title.
  expect(res.body.organiserName).toBe('Diwali Nights by Aurora Events');
});

test('AC2b with no share title, the display name still falls back to the event organiser name', async () => {
  const org = await createOrganiser({ email: 'share-fallback@test.dev', slug: 'share-fallback' });
  await createFreeEvent(org, { title: 'Fallback Fest', organizer: { name: 'Fallback Co', contact: '0412345678' } });

  const res = await byOrg('share-fallback');
  expect(res.status).toBe(200);
  expect(res.body.organiserName).toBe('Fallback Co');
});
