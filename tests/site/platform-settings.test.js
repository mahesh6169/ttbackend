// Platform Settings: the two admin switches that hide Deals and Coupons from the site menus.
// A missing settings record reads as "everything shown"; only an admin can change them, and the
// public read (used by the frontend layout) reflects the change straight away.
import { createUser } from '../helpers/factories.js';
import { api } from '../helpers/eventRequests.js';

const publicSettings = async () => (await api('get', '/api/settings')).body.settings;
const update = (user, body) => api('put', '/api/admin/platform-settings', user).send(body);

test('with nothing saved yet, Deals and Coupons both read as shown', async () => {
  const res = await api('get', '/api/settings');
  expect(res.status).toBe(200);
  expect(res.body.settings).toEqual({ showDeals: true, showCoupons: true });
});

test('an admin turns Deals off and back on; Coupons is untouched each time', async () => {
  const admin = await createUser({ role: 'admin' });

  const off = await update(admin, { showDeals: false });
  expect(off.status).toBe(200);
  expect(off.body.settings).toEqual({ showDeals: false, showCoupons: true });
  expect(await publicSettings()).toEqual({ showDeals: false, showCoupons: true });

  const read = await api('get', '/api/admin/platform-settings', admin);
  expect(read.status).toBe(200);
  expect(read.body.settings).toEqual({ showDeals: false, showCoupons: true });

  await update(admin, { showCoupons: false });
  expect(await publicSettings()).toEqual({ showDeals: false, showCoupons: false });

  await update(admin, { showDeals: true, showCoupons: true });
  expect(await publicSettings()).toEqual({ showDeals: true, showCoupons: true });
});

test('a regular user or a visitor cannot read or change the admin settings', async () => {
  const member = await createUser();

  expect((await update(member, { showDeals: false })).status).toBe(403);
  expect((await api('get', '/api/admin/platform-settings', member)).status).toBe(403);
  expect((await update(null, { showDeals: false })).status).toBe(401);
  expect(await publicSettings()).toEqual({ showDeals: true, showCoupons: true });
});

test('anything other than true/false, or no switch at all, is refused and changes nothing', async () => {
  const admin = await createUser({ role: 'admin' });

  const bad = await update(admin, { showDeals: 'no' });
  expect(bad.status).toBe(400);
  const empty = await update(admin, { somethingElse: true });
  expect(empty.status).toBe(400);
  expect(await publicSettings()).toEqual({ showDeals: true, showCoupons: true });
});
