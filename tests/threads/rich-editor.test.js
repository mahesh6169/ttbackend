// The thread rich-text sanitisation wall - see featureplans/threads-rich-editor.md and
// threads-url-display.md. The editor is politeness; the server is the wall: a crafted API request
// that bypasses the toolbar must come out clean, only https links survive as links, and the 15,000
// cap applies to visible TEXT, not the HTML wrapping.
import Thread from '../../models/threadModel.js';
import { createUser, createThread } from '../helpers/factories.js';
import { api } from '../helpers/eventRequests.js';

const SUBURB = {
  name: 'Sydney', state: 'NSW', postalCode: '2000',
  location: { type: 'Point', coordinates: [151.2093, -33.8688] },
};

// Post a thread over the real multipart endpoint (like the form). The response body is the created
// thread document.
const postThread = (user, question) =>
  api('post', '/api/threads/create', user)
    .field('title', 'A rich-text thread')
    .field('question', question)
    .field('category', 'General')
    .field('suburb', JSON.stringify(SUBURB));

const updateThread = (user, threadId, fields) => {
  const req = api('put', `/api/threads/update/${threadId}`, user);
  for (const [k, v] of Object.entries(fields)) req.field(k, v);
  return req;
};

test('allowed formatting (bold, italic, underline, strike, both lists, an https link) is kept as written', async () => {
  const user = await createUser();
  const html =
    '<p><strong>Bold</strong> <em>italic</em> <u>under</u> <s>strike</s></p>' +
    '<ul><li>bullet</li></ul><ol><li>number</li></ol>' +
    '<p><a href="https://example.com">https://example.com</a></p>';
  const res = await postThread(user, html);
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

test('scripts, event handlers, iframes and inline styles are stripped, keeping the text', async () => {
  const user = await createUser();
  const html =
    '<p onclick="steal()">visible</p>' +
    '<script>alert(1)</script>' +
    '<iframe src="https://evil.test"></iframe>' +
    '<p style="color:red">styled</p>';
  const res = await postThread(user, html);
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

test('a javascript: link is removed and an https link opens safely in a new tab', async () => {
  const user = await createUser();
  const html = '<p><a href="javascript:alert(1)">bad</a> <a href="https://ok.test">ok</a></p>';
  const res = await postThread(user, html);
  expect(res.status).toBe(201);
  const q = res.body.question;
  expect(q).not.toMatch(/javascript:/i);          // the dangerous href is gone
  expect(q).toContain('href="https://ok.test"');
  expect(q).toContain('target="_blank"');
  expect(q).toContain('rel="noopener noreferrer"');
});

test('editing an older plain-text thread leaves its text exactly as it was', async () => {
  const user = await createUser();
  const legacy = 'This is a legacy plain-text thread.\nSecond line, no HTML at all.';
  const thread = await createThread(user, { title: 'Legacy thread', question: legacy });

  // Change only the title; re-send the same plain-text description.
  const res = await updateThread(user, thread._id, {
    title: 'New title', question: legacy, category: 'General', suburb: JSON.stringify(SUBURB),
  });
  expect(res.status).toBeLessThan(400);
  const saved = await Thread.findById(thread._id);
  expect(saved.question).toBe(legacy); // byte-identical, no HTML-ification
});

test('more than 15000 characters of text is rejected, but HTML markup does not count toward the limit', async () => {
  const user = await createUser();

  const tooLong = 'x'.repeat(15001);
  const rejected = await postThread(user, tooLong);
  expect(rejected.status).toBe(400);
  expect(rejected.body.message).toMatch(/15000/);

  // ~3000 visible chars but ~24000 chars of HTML wrapping - counts as TEXT, so accepted.
  const heavyWrapping = '<p>a</p>'.repeat(3000);
  const accepted = await postThread(user, heavyWrapping);
  expect(accepted.status).toBe(201);
});

test('an http link becomes plain text while an https link stays a link', async () => {
  const user = await createUser();
  const html = '<p><a href="http://insecure.test">insecure link</a> and <a href="https://secure.test">secure link</a></p>';
  const res = await postThread(user, html);
  expect(res.status).toBe(201);
  const q = res.body.question;
  expect(q).not.toMatch(/http:\/\//i);                  // no http anywhere (anchor unwrapped)
  expect(q).not.toMatch(/<a[^>]*insecure/i);            // the http link is no longer an anchor
  expect(q).toContain('insecure link');                 // its text is kept
  expect(q).toContain('href="https://secure.test"');    // the https link survives
  expect(q).toContain('target="_blank"');
});
