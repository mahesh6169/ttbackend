// The thread rich-text sanitisation wall - see featureplans/threads-rich-editor.md and
// threads-url-display.md. The editor is politeness; the server is the wall: a crafted API request
// that bypasses the toolbar must come out clean, only https links survive as links, and the 15,000
// cap applies to visible TEXT, not the HTML wrapping.
import { jest } from '@jest/globals';
import Thread from '../../models/threadModel.js';
import ThreadPictureUpload from '../../models/threadPictureUploadModel.js';
import { tidyUnusedThreadPictures } from '../../controllers/threads/threadController.js';
import cloudinary from '../../utils/cloudinary.js';
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

// Feature 1012: the new editor marks that pictures live in the post text.
const postBlogThread = (user, question) => postThread(user, question).field('picturesInText', 'true');

// A picture URL exactly like the thread picture upload returns (tests run with NODE_ENV=test,
// so the folder is tagtelugudev/threads).
const CLOUD = process.env.CLOUDINARY_CLOUD_NAME || 'dtvrbdvkx';
const pic = (id) => `https://res.cloudinary.com/${CLOUD}/image/upload/v1730000000/tagtelugudev/threads/${id}.jpg`;
const block = (...ids) =>
  `<div data-pictures=""><${ids.map((id) => `img src="${pic(id)}" alt="" width="1600" height="1200"`).join('><')}></div>`;

afterEach(() => jest.restoreAllMocks());

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


// ---------------------------------------------------------------------------------------------
// Feature 1012 - blog-style posts: headings, pictures between paragraphs, picture upload.
// ---------------------------------------------------------------------------------------------

test('headings and our own pictures are kept; pictures from other sites, embedded data and other blocks are removed', async () => {
  const user = await createUser();
  const html =
    '<h2>Heading</h2><h3>Subheading</h3><h1>Too big</h1>' +
    `<div data-pictures="" onclick="x()"><img src="${pic('good1')}" alt="dosa" width="1600" height="1200" onerror="x()">` +
    '<img src="https://evil.test/a.jpg"><img src="data:image/png;base64,AAAA"></div>' +
    `<div class="box">plain block</div><img src="${pic('good2').replace('/threads/', '/listings/')}">`;
  const res = await postBlogThread(user, html);
  expect(res.status).toBe(201);
  const q = res.body.question;
  expect(q).toContain('<h2>Heading</h2>');
  expect(q).toContain('<h3>Subheading</h3>');
  expect(q).not.toMatch(/<h1/i);
  expect(q).toContain('Too big');                      // text kept
  expect(q).toContain(`src="${pic('good1')}"`);
  expect(q).toContain('width="1600"');
  expect(q).not.toMatch(/evil\.test|data:image|\/listings\//);
  expect(q).not.toMatch(/onclick|onerror|class=/i);
  expect(q).toContain('plain block');                  // other div unwrapped, text kept
  expect((q.match(/<img/g) || []).length).toBe(1);
});

test('pictures in the post become the thread pictures, in reading order, for cards and share previews', async () => {
  const user = await createUser();
  const html = `<p>one</p>${block('p1')}<p>two</p>${block('p2', 'p3')}`;
  const res = await postBlogThread(user, html);
  expect(res.status).toBe(201);
  const saved = await Thread.findById(res.body._id).lean();
  expect(saved.images.map((i) => i.publicId)).toEqual([
    'tagtelugudev/threads/p1', 'tagtelugudev/threads/p2', 'tagtelugudev/threads/p3',
  ]);
  expect(saved.images[0].url).toBe(pic('p1'));
});

test('a thread can have at most 10 pictures', async () => {
  const user = await createUser();
  const ten = Array.from({ length: 10 }, (_, i) => `x${i}`);
  expect((await postBlogThread(user, block(...ten))).status).toBe(201);
  const rejected = await postBlogThread(user, block(...ten, 'x10'));
  expect(rejected.status).toBe(400);
  expect(rejected.body.message).toMatch(/10 pictures/);
});

test('editing a post deletes only the pictures taken out of it from storage', async () => {
  const destroy = jest.spyOn(cloudinary.uploader, 'destroy').mockResolvedValue({ result: 'ok' });
  const user = await createUser();
  const created = await postBlogThread(user, `<p>a</p>${block('keep', 'drop')}`);
  expect(created.status).toBe(201);

  const res = await updateThread(user, created.body._id, {
    question: `<p>a</p>${block('keep')}`, picturesInText: 'true',
  });
  expect(res.status).toBe(200);
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(destroy).toHaveBeenCalledWith('tagtelugudev/threads/drop');
  const saved = await Thread.findById(created.body._id).lean();
  expect(saved.images.map((i) => i.publicId)).toEqual(['tagtelugudev/threads/keep']);
});

test('picture upload: needs a login, accepts JPEG/PNG/WebP only, and returns the stored picture', async () => {
  const uploadStream = jest.spyOn(cloudinary.uploader, 'upload_stream').mockImplementation((opts, cb) => ({
    end: () => cb(null, {
      secure_url: pic('fresh'), public_id: `${opts.folder}/fresh`, width: 2000, height: 1500,
    }),
  }));
  const user = await createUser();
  const jpg = { filename: 'photo.jpg', contentType: 'image/jpeg' };

  const anon = await api('post', '/api/threads/pictures').attach('images', Buffer.from('fake'), jpg);
  expect(anon.status).toBe(401);

  const gif = await api('post', '/api/threads/pictures', user)
    .attach('images', Buffer.from('fake'), { filename: 'a.gif', contentType: 'image/gif' });
  expect(gif.status).toBe(400);

  const ok = await api('post', '/api/threads/pictures', user).attach('images', Buffer.from('fake'), jpg);
  expect(ok.status).toBe(201);
  expect(ok.body).toEqual({ url: pic('fresh'), publicId: 'tagtelugudev/threads/fresh', width: 2000, height: 1500 });
  // Stored in the threads folder, capped at 2000px.
  const opts = uploadStream.mock.calls[0][0];
  expect(opts.folder).toBe('tagtelugudev/threads');
  expect(opts.transformation[0]).toMatchObject({ width: 2000, height: 2000, crop: 'limit' });
  // The upload is noted for the unused-picture tidy-up.
  expect(await ThreadPictureUpload.countDocuments({ publicId: 'tagtelugudev/threads/fresh' })).toBe(1);
});

test('pictures uploaded but never used in a saved thread are deleted after 24 hours; used and recent ones stay', async () => {
  const destroy = jest.spyOn(cloudinary.uploader, 'destroy').mockResolvedValue({ result: 'ok' });
  const user = await createUser();
  const created = await postBlogThread(user, `<p>a</p>${block('used')}`);
  expect(created.status).toBe(201);
  const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await ThreadPictureUpload.collection.insertMany([
    { publicId: 'tagtelugudev/threads/used', createdAt: dayAgo, updatedAt: dayAgo },
    { publicId: 'tagtelugudev/threads/abandoned', createdAt: dayAgo, updatedAt: dayAgo },
    { publicId: 'tagtelugudev/threads/still-writing', createdAt: new Date(), updatedAt: new Date() },
  ]);

  const out = await tidyUnusedThreadPictures();
  expect(out).toEqual({ checked: 2, deleted: 1 });
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(destroy).toHaveBeenCalledWith('tagtelugudev/threads/abandoned');
  // The old notes are gone; the recent one waits for its 24 hours.
  expect((await ThreadPictureUpload.find().lean()).map((n) => n.publicId)).toEqual(['tagtelugudev/threads/still-writing']);
});
