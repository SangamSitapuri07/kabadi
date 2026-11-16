import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../../apps/api/dist/app.js';

const origin = 'http://localhost:3000';
async function withServer(auth, fn) {
  const server = createApp(auth).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${server.address().port}/api/v1/account/customer`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const request = (url, body, extra = {}) => fetch(url, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...extra }, body });

test('customer route is unavailable when not configured', async () => {
  await withServer(undefined, async url => assert.equal((await request(url, '{}')).status, 503));
});

test('customer route rejects malformed requests before resolving identity', async () => {
  let calls = 0;
  const auth = { origin, handler: async () => {}, resolveIdentity: async () => { calls++; return { userId: null, cookies: [] }; }, onboardCustomer: async () => 'ready' };
  await withServer(auth, async url => {
    assert.equal((await request(url, '{}', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await request(url, '{}', { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await request(url, 'x'.repeat(1025))).status, 413);
    assert.equal((await request(url, '{')).status, 400);
    for (const body of ['[]', 'null', '{"role":"admin"}', '{"userId":"other"}']) assert.equal((await request(url, body)).status, 400);
    assert.equal(calls, 0);
  });
});

test('customer route uses session identity and propagates refresh cookies without exposing failures', async () => {
  let resolved = { userId: 'trusted', cookies: ['session=refresh; HttpOnly'] }, result = 'ready', seen;
  const auth = { origin, handler: async () => {}, resolveIdentity: async () => resolved, onboardCustomer: async id => { seen = id; return result; } };
  await withServer(auth, async url => {
    let response = await request(url, '{}', { 'x-user-id': 'forged', 'x-role': 'admin' });
    assert.equal(response.status, 200); assert.equal(seen, 'trusted');
    assert.deepEqual(await response.json(), { data: { customer: 'ready' } });
    assert.deepEqual(response.headers.getSetCookie(), ['session=refresh; HttpOnly']);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    result = 'forbidden'; response = await request(url, '{}'); assert.equal(response.status, 403);
    assert.deepEqual(response.headers.getSetCookie(), ['session=refresh; HttpOnly']);
    resolved = { userId: null, cookies: [] }; assert.equal((await request(url, '{}')).status, 401);
    resolved = { userId: '', cookies: [] }; assert.equal((await request(url, '{}')).status, 503);
    resolved = { userId: 'trusted', cookies: [] }; result = 'unexpected'; assert.equal((await request(url, '{}')).status, 503);
    auth.onboardCustomer = async () => { throw Error('private error'); };
    response = await request(url, '{}'); assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: { code: 'ACCOUNT_UNAVAILABLE', message: 'Customer setup is unavailable.' } });
  });
});
