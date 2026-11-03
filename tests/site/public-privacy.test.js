// Feature 1012 security fix: public lists must never send the poster's account record.
// Before the fix, GET /api/threads and GET /api/adverts/search returned the whole user document
// (email, mobile, role, location, password-reset and email-verify codes).
import User from '../../models/userModel.js';
import { createUser, createThread, createAdvert } from '../helpers/factories.js';
import { api } from '../helpers/eventRequests.js';

const PRIVATE_FIELDS = [
  'email', 'mobile', 'role', 'password', 'resetOtp', 'verifyOtp', 'resetOtpExpireAt',
  'verifyOtpExpireAt', 'suburb', 'stripeAccountId', 'stripeAccountStatus', 'wishlist',
];

// A poster with secrets on their account, like a user in the middle of a password reset.
const posterWithSecrets = async () => {
  const user = await createUser({ name: 'Public Name' });
  await User.updateOne({ _id: user._id }, { $set: { resetOtp: '123456', verifyOtp: '654321' } });
  return user;
};

test('the public thread list shows only the poster\'s name, never their account details', async () => {
  const poster = await posterWithSecrets();
  await createThread(poster);

  const res = await api('get', '/api/threads?limit=5');
  expect(res.status).toBe(200);
  const owner = res.body.threads[0].owner;
  expect(owner.name).toBe('Public Name');
  expect(String(owner._id)).toBe(String(poster._id));
  for (const field of PRIVATE_FIELDS) expect(owner).not.toHaveProperty(field);
  expect(JSON.stringify(res.body)).not.toMatch(/123456|654321/);
});

test('the public listings search shows only the poster\'s name, never their account details', async () => {
  const poster = await posterWithSecrets();
  await createAdvert(poster);

  const res = await api('get', '/api/adverts/search?limit=5');
  expect(res.status).toBe(200);
  const user = res.body.data.adverts[0].user;
  expect(user.name).toBe('Public Name');
  for (const field of PRIVATE_FIELDS) expect(user).not.toHaveProperty(field);
  expect(JSON.stringify(res.body)).not.toMatch(/123456|654321/);
});
