import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCustomerDetails } from '../../apps/api/dist/customer-details.js';

const valid = { name: '  ਜਸਪ੍ਰੀਤ  ', addressLine: '  12 ਗਲੀ  ', city: 'Ludhiana', state: 'Punjab', postalCode: '141001' };
test('customer details accept bounded Unicode and trim, without interpreting identity fields', () => {
  assert.deepEqual(parseCustomerDetails(valid), { ...valid, name: 'ਜਸਪ੍ਰੀਤ', addressLine: '12 ਗਲੀ' });
  assert.equal(parseCustomerDetails({ ...valid, userId: 'another-user' }), null);
  assert.equal(parseCustomerDetails({ ...valid, role: 'admin' }), null);
  assert.equal(parseCustomerDetails({ ...valid, addressLine: undefined }), null);
  assert.equal(parseCustomerDetails({ ...valid, city: '  ' }), null);
  assert.equal(parseCustomerDetails({ ...valid, city: '\u0000' }), null);
  assert.equal(parseCustomerDetails({ ...valid, city: 'x\ny' }), null);
  assert.equal(parseCustomerDetails({ ...valid, name: 'x'.repeat(101) }), null);
  assert.equal(parseCustomerDetails({ ...valid, name: '\ud800' }), null);
  assert.ok(parseCustomerDetails({ ...valid, name: '😀'.repeat(100) }));
  for (const input of [null, [], 'text', {}, 42]) assert.equal(parseCustomerDetails(input), null);
});

import { once } from 'node:events';
import { createApp } from '../../apps/api/dist/app.js';
const origin = 'http://localhost:3000';
const details = { name: 'Test User', addressLine: '12 Example', city: 'Ludhiana', state: 'Punjab', postalCode: '141001' };
const put = (url, body, extra = {}) => fetch(url, { method: 'PUT', headers: { origin, 'content-type': 'application/json', ...extra }, body });
async function withServer(auth, run) {
  const server = createApp(auth).listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}/api/v1/account/customer/details`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('details route validates origin, body and identity, never trusts browser user IDs', async () => {
  let identity = { userId: 'trusted', cookies: ['session=refresh; HttpOnly'] }, calls = [], read = null, result = 'saved';
  const auth = { origin, handler: async () => {}, resolveIdentity: async () => identity,
    customerDetails: { read: async id => { calls.push(['read', id]); return read; }, write: async (id, value) => { calls.push(['write', id, value]); return result; } } };
  await withServer(undefined, async url => { assert.equal((await fetch(url)).status, 503); assert.equal((await put(url, '{}')).status, 503); });
  await withServer(auth, async url => {
    const body = JSON.stringify(details);
    assert.equal((await put(url, body, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await put(url, body, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await put(url, 'x'.repeat(4097))).status, 413);
    assert.equal((await put(url, '{')).status, 400);
    assert.equal((await put(url, JSON.stringify({ ...details, userId: 'forged' }))).status, 400);
    assert.equal(calls.length, 0);
    let response = await put(url, body, { 'x-user-id': 'forged', 'x-role': 'admin' });
    assert.deepEqual(calls.pop(), ['write', 'trusted', details]);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(response.headers.getSetCookie(), ['session=refresh; HttpOnly']);
    assert.deepEqual(await response.json(), { data: { saved: true } });
    response = await fetch(url); assert.deepEqual(await response.json(), { data: { details: null } });
    assert.deepEqual(calls.pop(), ['read', 'trusted']);
    read = details; response = await fetch(url); assert.deepEqual(await response.json(), { data: { details } });
    read = { ...details, extra: 'private' }; assert.equal((await fetch(url)).status, 503);
    read = 'forbidden'; response = await fetch(url); assert.equal(response.status, 403);
    result = 'forbidden'; assert.equal((await put(url, body)).status, 403);
    identity = { userId: null, cookies: [] }; assert.equal((await fetch(url)).status, 401); assert.equal((await put(url, body)).status, 401);
    identity = { userId: '', cookies: [] }; assert.equal((await fetch(url)).status, 503);
    identity = { userId: 'trusted', cookies: [] }; result = 'unexpected'; assert.equal((await put(url, body)).status, 503);
    auth.customerDetails.read = async () => { throw Error('secret'); };
    response = await fetch(url); assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('secret'));
  });
});
