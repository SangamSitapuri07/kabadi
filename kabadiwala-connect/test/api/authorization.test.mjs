import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { requireRoles } from '../../apps/api/dist/authorization.js';

async function withRoute(dependencies, run, allowed = ['admin']) {
  const app = express();
  app.get('/protected', requireRoles(dependencies, allowed), (_req, res) => {
    res.json({ data: res.locals.principal });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}/protected`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const identity = userId => async () => ({ userId, cookies: [] });
const lookup = record => async () => record;

 test('protected route denies anonymous and unconfigured access', async () => {
  await withRoute(undefined, async url => assert.equal((await fetch(url)).status, 503));
  let queried = false;
  await withRoute({ resolveIdentity: identity(null), lookupAccount: async () => { queried = true; } }, async url => {
    const response = await fetch(url);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
  assert.equal(queried, false);
});

test('roles and account status are checked against current trusted records', async () => {
  let record = { status: 'active', roles: ['customer'] };
  let seen;
  const deps = { resolveIdentity: identity('trusted-user'), lookupAccount: async id => { seen = id; return record; } };
  await withRoute(deps, async url => {
    const headers = { 'x-user-id': 'admin', 'x-role': 'admin' };
    assert.equal((await fetch(url, { headers })).status, 403);
    assert.equal(seen, 'trusted-user');
    record = { status: 'active', roles: ['customer', 'admin'] };
    const authorized = await fetch(url, { headers });
    assert.equal(authorized.status, 200);
    assert.deepEqual((await authorized.json()).data, { userId: 'trusted-user', roles: ['customer', 'admin'] });
    record = { status: 'suspended', roles: ['admin'] };
    assert.equal((await fetch(url)).status, 403);
    record = null;
    assert.equal((await fetch(url)).status, 403);
    record = { status: 'active', roles: [] };
    assert.equal((await fetch(url)).status, 403);
  });
});

test('errors and invalid data fail closed without exposing details', async () => {
  for (const deps of [
    { resolveIdentity: async () => { throw Error('private session'); }, lookupAccount: lookup(null) },
    { resolveIdentity: async () => ({ userId: '', cookies: [] }), lookupAccount: lookup(null) },
    { resolveIdentity: identity('id'), lookupAccount: async () => { throw Error('private database'); } },
    ...[undefined, {}, { status: 'active', roles: ['admin', 'unexpected'] }, { status: 'unknown', roles: ['admin'] }, { status: 'active', roles: 'admin' }]
      .map(record => ({ resolveIdentity: identity('id'), lookupAccount: lookup(record) })),
  ]) {
    await withRoute(deps, async url => {
      const response = await fetch(url);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: { code: 'AUTHORIZATION_UNAVAILABLE', message: 'Access is unavailable.' } });
    });
  }
  assert.throws(() => requireRoles(undefined, []));
  assert.throws(() => requireRoles(undefined, ['bogus']));
});

test('refreshed cookies survive both authorization and denial', async () => {
  const deps = { resolveIdentity: async cookie => {
    assert.equal(cookie, 'session=valid');
    return { userId: 'id', cookies: ['session=refreshed; HttpOnly', 'other=renewed; HttpOnly'] };
  }, lookupAccount: lookup({ status: 'active', roles: ['customer'] }) };
  for (const role of ['customer', 'admin']) {
    await withRoute(deps, async url => {
      const response = await fetch(url, { headers: { cookie: 'session=valid' } });
      assert.equal(response.status, role === 'customer' ? 200 : 403);
      assert.deepEqual(response.headers.getSetCookie(), ['session=refreshed; HttpOnly', 'other=renewed; HttpOnly']);
    }, [role]);
  }
});
