// Proves the thread rich-text sanitisation wall - see featureplans/threads-rich-editor.md.
// The editor is politeness; the server is the wall: a crafted API request that bypasses the toolbar
// must come out clean, and the 15,000 cap applies to visible TEXT, not the HTML wrapping.
import request from 'supertest';
import app from '../app.js';
import Thread from '../models/threadModel.js';
import { createUser, cookieFor, API_KEY } from './helpers/factories.js';

const SUBURB = {
  name: 'Sydney', state: 'NSW', postalCode: '2000',
  location: { type: 'Point', coordinates: [151.2093, -33.8688] },
};

// Create a thread over the real multipart endpoint (like the form). Returns the supertest response;
// the body is the created thread document.
const createThread = (user, question, overrides = {}) =>
  request(app)
    .post('/api/threads/create')
    .set('Cookie', cookieFor(user))
    .set('x-api-key', API_KEY)
    .field('title', overrides.title || 'A rich-text thread')
    .field('question', question)
    .field('category', 'General')
    .field('suburb', JSON.stringify(SUBURB));

const updateThread = (user, threadId, fields) => {
  const req = request(app)
    .put(`/api/threads/update/${threadId}`)
    .set('Cookie', cookieFor(user))
    .set('x-api-key', API_KEY);
  for (const [k, v] of Object.entries(fields)) req.field(k, v);
  return req;
};

// Seed a "legacy" plain-text thread straight through the model (created before this feature existed).
const seedLegacyThread = (user, question) =>
  Thread.create({
    title: 'Legacy thread', question, category: 'General', owner: user._id,
    participants: [user._id], suburb: SUBURB,
  });

test('AC1 allowlisted rich HTML (bold, underline, strike, both lists, an https link) round-trips intact', async () => {
  const user = await createUser();
  const html =
    '<p><strong>Bold</strong> <em>italic</em> <u>under</u> <s>strike</s></p>' +
    '<ul><li>bullet</li></ul><ol><li>number</li></ol>' +
    '<p><a href="https://example.com">https://example.com</a></p>';
  const res = await createThread(user, html);
  expect(res.status).toBe(201);
  const q = res.body.question;
  expect(q).toContain('<strong>Bold</strong>');
  expect(q).toContain('<em>italic</em>');
  expect(q).toContain('<u>under</u>');
  expect(q).toContain('<s>strike</s>');
  expect(q).toContain('<ul><li>bullet</li></ul>');
  expect(q).toContain('<ol><li>number</li></ol>');
  expect(q).toContain('href="https://example.com"');
});

test('AC2 crafted script/onclick/iframe/style content is stripped to allowlisted tags only', async () => {
  const user = await createUser();
  const html =
    '<p onclick="steal()">visible</p>' +
    '<script>alert(1)</script>' +
    '<iframe src="https://evil.test"></iframe>' +
    '<p style="color:red">styled</p>';
  const res = await createThread(user, html);
  expect(res.status).toBe(201);
  const q = res.body.question;
  expect(q).not.toMatch(/<script/i);
  expect(q).not.toMatch(/onclick/i);
  expect(q).not.toMatch(/<iframe/i);
  expect(q).not.toMatch(/style=/i);
  // Text survives inside allowlisted tags.
  expect(q).toContain('visible');
  expect(q).toContain('styled');
});

test('AC3 a javascript: anchor is neutralised; an https anchor gets rel + target enforced', async () => {
  const user = await createUser();
  const html = '<p><a href="javascript:alert(1)">bad</a> <a href="https://ok.test">ok</a></p>';
  const res = await createThread(user, html);
  expect(res.status).toBe(201);
  const q = res.body.question;
  expect(q).not.toMatch(/javascript:/i);          // the dangerous href is gone
  expect(q).toContain('href="https://ok.test"');
  expect(q).toContain('target="_blank"');
  expect(q).toContain('rel="noopener noreferrer"');
});

test('AC4 an unrelated update to a legacy plain-text thread leaves its content byte-identical', async () => {
  const user = await createUser();
  const legacy = 'This is a legacy plain-text thread.\nSecond line, no HTML at all.';
  const thread = await seedLegacyThread(user, legacy);

  // Change only the title; re-send the same plain-text description.
  const res = await updateThread(user, thread._id, {
    title: 'New title', question: legacy, category: 'General', suburb: JSON.stringify(SUBURB),
  });
  expect(res.status).toBeLessThan(400);
  const saved = await Thread.findById(thread._id);
  expect(saved.question).toBe(legacy); // byte-identical, no HTML-ification
});

test('AC5 text over 15000 is rejected server-side; short text with heavy HTML wrapping is accepted', async () => {
  const user = await createUser();

  const tooLong = 'x'.repeat(15001);
  const rejected = await createThread(user, tooLong);
  expect(rejected.status).toBe(400);
  expect(rejected.body.message).toMatch(/15000/);

  // ~3000 visible chars but ~24000 chars of HTML wrapping - counts as TEXT, so accepted.
  const heavyWrapping = '<p>a</p>'.repeat(3000);
  const accepted = await createThread(user, heavyWrapping);
  expect(accepted.status).toBe(201);
});

// ─── https-only tightening (featureplans/threads-url-display.md) ─────────────────────────────────

test('AC5 (url-display) an http anchor is unwrapped to plain text; an https anchor survives', async () => {
  const user = await createUser();
  const html = '<p><a href="http://insecure.test">insecure link</a> and <a href="https://secure.test">secure link</a></p>';
  const res = await createThread(user, html);
  expect(res.status).toBe(201);
  const q = res.body.question;
  expect(q).not.toMatch(/http:\/\//i);                  // no http anywhere (anchor unwrapped)
  expect(q).not.toMatch(/<a[^>]*insecure/i);            // the http link is no longer an anchor
  expect(q).toContain('insecure link');                 // its text is kept
  expect(q).toContain('href="https://secure.test"');    // the https link survives
  expect(q).toContain('target="_blank"');
});
