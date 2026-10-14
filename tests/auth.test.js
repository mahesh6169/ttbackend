// Proves the auth round-trip against the test DB: register a member, log in, validate the session.
import request from 'supertest';
import app from '../app.js';
import User from '../models/userModel.js';

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

test('register creates a user and issues an auth cookie', async () => {
  const email = 'alice@test.dev';
  const res = await request(app).post('/api/users/register').send(validRegistration(email));

  expect(res.status).toBeLessThan(400);
  const setCookie = res.headers['set-cookie'] || [];
  expect(setCookie.join(';')).toMatch(/token=/);

  const inDb = await User.findOne({ email });
  expect(inDb).toBeTruthy();
  expect(inDb.role).not.toBe('guest');
});

test('login then validate returns the member', async () => {
  const email = 'bob@test.dev';
  await request(app).post('/api/users/register').send(validRegistration(email));

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

test('login with a wrong password is rejected', async () => {
  const email = 'carol@test.dev';
  await request(app).post('/api/users/register').send(validRegistration(email));

  const login = await request(app)
    .post('/api/users/login')
    .send({ email, password: 'wrongpass' });
  expect(login.status).toBe(401);
});
