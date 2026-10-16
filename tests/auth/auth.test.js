// Member sign-up and login against the test DB: register, log in, validate the session, and the
// unique-email guard under parallel fire.
import request from 'supertest';
import app from '../../app.js';
import User from '../../models/userModel.js';

const validRegistration = (email) => ({
  name: 'Alice Tester',
  email,
  password: 'test1234',
  confirmPassword: 'test1234',
  suburb: {
    name: 'Sydney',
    state: 'NSW',
    postalCode: '2000',
    location: { type: 'Point', coordinates: [151.2093, -33.8688] },
  },
  captchaToken: 'test-token',
});

const register = (email) => request(app).post('/api/users/register').send(validRegistration(email));

test('registering creates a member and issues an auth cookie', async () => {
  const email = 'alice@test.dev';
  const res = await register(email);

  expect(res.status).toBeLessThan(400);
  const setCookie = res.headers['set-cookie'] || [];
  expect(setCookie.join(';')).toMatch(/token=/);

  const inDb = await User.findOne({ email });
  expect(inDb).toBeTruthy();
  expect(inDb.role).not.toBe('guest');
});

test('a member can log in and the session validates as that member', async () => {
  const email = 'bob@test.dev';
  await register(email);

  const login = await request(app)
    .post('/api/users/login')
    .send({ email, password: 'test1234' });
  expect(login.status).toBe(200);
  expect(login.body.success).toBe(true);

  const cookie = login.headers['set-cookie'];
  const validate = await request(app).get('/api/users/validate').set('Cookie', cookie);
  expect(validate.status).toBe(200);
  expect(validate.body.user.email).toBe(email);
});

test('logging in with a wrong password is rejected', async () => {
  const email = 'carol@test.dev';
  await register(email);

  const login = await request(app)
    .post('/api/users/login')
    .send({ email, password: 'wrongpass' });
  expect(login.status).toBe(401);
});

// The unique email index is a genuinely atomic guard: two identical registrations racing in
// parallel leave exactly one user.
test('two identical registrations sent at the same time create only one member', async () => {
  const email = 'race-dup@test.dev';
  const fire = () => register(email).catch(() => null);

  await Promise.all([fire(), fire()]);

  expect(await User.countDocuments({ email })).toBe(1);
});
