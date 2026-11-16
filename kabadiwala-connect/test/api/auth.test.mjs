import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../../apps/api/dist/app.js';
import { readAuthConfig } from '../../apps/api/dist/auth.js';

const valid = { AUTH_ENABLED: 'true', AUTH_PUBLIC_ORIGIN: 'http://127.0.0.1:3000', DATABASE_URL: 'postgres://test:secret@127.0.0.1:5432/test', BETTER_AUTH_SECRET: 'x'.repeat(48), GOOGLE_CLIENT_ID: 'fake', GOOGLE_CLIENT_SECRET: 'fake' };
test('auth configuration is opt-in and fails closed', () => {
  assert.equal(readAuthConfig({}), null);
  assert.equal(readAuthConfig({ AUTH_ENABLED: 'false' }), null);
  assert.throws(() => readAuthConfig({ ...valid, AUTH_ENABLED: 'bad' }));
  assert.throws(() => readAuthConfig({ ...valid, NODE_ENV: 'production' }));
  assert.throws(() => readAuthConfig({ ...valid, GOOGLE_CLIENT_SECRET: '' }));
  assert.throws(() => readAuthConfig({ ...valid, BETTER_AUTH_SECRET: 'short' }));
  for (const origin of ['http://example.com', 'https://example.com/path', 'https://example.com/', 'https://user:pass@example.com', 'https://example.com?x=1']) {
    assert.throws(() => readAuthConfig({ ...valid, AUTH_PUBLIC_ORIGIN: origin }));
  }
  assert.throws(() => readAuthConfig({ ...valid, DATABASE_URL: 'https://example.com' }));
  assert.equal(readAuthConfig(valid).origin, valid.AUTH_PUBLIC_ORIGIN);
});

test('disabled endpoints fail closed and unrelated auth routes stay hidden', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(origin + '/api/auth/get-session')).status, 503);
    assert.equal((await fetch(origin + '/api/auth/sign-in/email', { method: 'POST' })).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('auth mount enforces configured POST origin, content type and body limit', async () => {
  let calls = 0;
  const server = createApp({ origin: valid.AUTH_PUBLIC_ORIGIN, handler: async (_req, res) => { calls++; res.end('ok'); } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/auth/sign-in/social`;
    for (const origin of [undefined, 'https://evil.example']) {
      const headers = { 'content-type': 'application/json' }; if (origin) headers.origin = origin;
      assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 403);
    }
    assert.equal((await fetch(url, { method: 'POST', headers: { origin: valid.AUTH_PUBLIC_ORIGIN, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await fetch(url, { method: 'POST', headers: { origin: valid.AUTH_PUBLIC_ORIGIN, 'content-type': 'application/json' }, body: 'x'.repeat(8193) })).status, 413);
    assert.equal((await fetch(url, { method: 'POST', headers: { origin: valid.AUTH_PUBLIC_ORIGIN, 'content-type': 'application/json' }, body: '{}' })).status, 200);
    assert.equal(calls, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
