// Feature 1012: the group chat switch on a thread, and what an admin may change on someone else's
// thread (moderation only: category + chat switch, never the words or pictures).
import Thread from '../../models/threadModel.js';
import ThreadMessage from '../../models/threadMessageModel.js';
import { createUser, createThread } from '../helpers/factories.js';
import { api } from '../helpers/eventRequests.js';

const sendMessage = (user, threadId, message) =>
  api('post', '/api/threads/send', user).send({ threadId: String(threadId), message });

test('chat is on by default; when turned off no message is accepted, and old messages come back when turned on again', async () => {
  const author = await createUser();
  const reader = await createUser();
  const thread = await createThread(author);
  expect(thread.allowChat).toBe(true);

  expect((await sendMessage(reader, thread._id, 'before')).status).toBe(201);

  // The author turns chat off from the edit page.
  const off = await api('put', `/api/threads/update/${thread._id}`, author).field('allowChat', 'false');
  expect(off.status).toBe(200);
  const refused = await sendMessage(reader, thread._id, 'while off');
  expect(refused.status).toBe(403);
  expect(refused.body.message).toMatch(/turned off/i);

  // Turned back on: the earlier message is still there and new ones are accepted.
  await api('put', `/api/threads/update/${thread._id}`, author).field('allowChat', 'true');
  expect((await sendMessage(reader, thread._id, 'after')).status).toBe(201);
  const messages = await ThreadMessage.find({ thread: thread._id }).lean();
  expect(messages.map((m) => m.message).sort()).toEqual(['after', 'before']);
});

test('a new thread can be posted with chat turned off, and the public page reports it', async () => {
  const author = await createUser();
  const res = await api('post', '/api/threads/create', author)
    .field('title', 'Announcement')
    .field('question', '<p>No replies needed</p>')
    .field('category', 'General Enquiries')
    .field('allowChat', 'false')
    .field('suburb', JSON.stringify({
      name: 'Sydney', state: 'NSW', postalCode: '2000',
      location: { type: 'Point', coordinates: [151.2093, -33.8688] },
    }));
  expect(res.status).toBe(201);
  expect(res.body.allowChat).toBe(false);
  const page = await api('get', `/api/threads/public/${res.body._id}`);
  expect(page.status).toBe(200);
  expect(page.body.thread?.allowChat ?? page.body.allowChat).toBe(false);
});

test('an admin can change the category and chat switch of someone else\'s thread, but not its words', async () => {
  const admin = await createUser({ role: 'admin' });
  const author = await createUser();
  const thread = await createThread(author, { question: '<p>original words</p>', category: 'Food & Dining' });

  const res = await api('patch', `/api/admin/threads/${thread._id}/moderate`, admin)
    .send({ category: 'Coming Soon & New Openings', allowChat: false, question: '<p>admin words</p>' });
  expect(res.status).toBe(200);

  const saved = await Thread.findById(thread._id).lean();
  expect(saved.category).toBe('Coming Soon & New Openings');
  expect(saved.allowChat).toBe(false);
  expect(saved.question).toBe('<p>original words</p>');      // words untouched
  expect(String(saved.owner)).toBe(String(author._id));       // still the author's thread
});

test('moderation is admin-only and only accepts a known category', async () => {
  const admin = await createUser({ role: 'admin' });
  const author = await createUser();
  const thread = await createThread(author);
  const url = `/api/admin/threads/${thread._id}/moderate`;

  expect((await api('patch', url, author).send({ allowChat: false })).status).toBe(403);
  expect((await api('patch', url).send({ allowChat: false })).status).toBe(401);
  expect((await api('patch', url, admin).send({ category: 'Not A Category' })).status).toBe(400);
  expect((await api('patch', url, admin).send({})).status).toBe(400);

  // The admin cannot rewrite someone else's thread through the normal edit either.
  const edit = await api('put', `/api/threads/update/${thread._id}`, admin).field('question', '<p>x</p>');
  expect(edit.status).toBe(403);
});
