import test from 'node:test';
import assert from 'node:assert/strict';
import { readAuthConfig, createDevSignIn } from '../../apps/api/dist/auth.js';

const valid = {
  AUTH_ENABLED: 'true', AUTH_PUBLIC_ORIGIN: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/kabadi',
  BETTER_AUTH_SECRET: 'x'.repeat(40),
  GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret',
};

test('development sign-in is off unless explicitly asked for', () => {
  assert.equal(readAuthConfig(valid).devSignIn, false);
  assert.equal(readAuthConfig({ ...valid, DEV_SIGNIN_ENABLED: 'false' }).devSignIn, false);
  assert.equal(readAuthConfig({ ...valid, DEV_SIGNIN_ENABLED: 'yes' }).devSignIn, true);
  // Not "true", not "y", not "1": one spelling, so a typo cannot half-enable it.
  assert.throws(() => readAuthConfig({ ...valid, DEV_SIGNIN_ENABLED: 'true' }));
  assert.throws(() => readAuthConfig({ ...valid, DEV_SIGNIN_ENABLED: '1' }));
});

test('development sign-in is refused in production, even when asked for', () => {
  assert.throws(() => readAuthConfig({ ...valid, DEV_SIGNIN_ENABLED: 'yes', NODE_ENV: 'production' }),
    /cannot be enabled in production/);
  // And production refuses ordinary auth regardless, so there is no environment
  // where this becomes reachable by being left switched on.
  assert.throws(() => readAuthConfig({ ...valid, NODE_ENV: 'production' }));
});

test('development sign-in is refused on any origin a real user could reach', () => {
  // A password account with a known password on a public host is a production
  // authentication surface with development guarantees.
  for (const origin of ['https://kabadi.example.com', 'https://app.example.org']) {
    assert.throws(() => readAuthConfig({ ...valid, AUTH_PUBLIC_ORIGIN: origin, DEV_SIGNIN_ENABLED: 'yes' }),
      /local origin/, origin);
  }
  // A LAN address is refused even earlier: the general rule only allows HTTPS or
  // a loopback host, so this never reaches the dev-signin check. It must still
  // be impossible, whichever guard stops it.
  assert.throws(() => readAuthConfig({ ...valid, AUTH_PUBLIC_ORIGIN: 'http://192.168.1.10:3000', DEV_SIGNIN_ENABLED: 'yes' }));
  // Every local spelling is fine.
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
    assert.equal(readAuthConfig({ ...valid, AUTH_PUBLIC_ORIGIN: origin, DEV_SIGNIN_ENABLED: 'yes' }).devSignIn, true, origin);
  }
});

const config = { ...readAuthConfig({ ...valid, DEV_SIGNIN_ENABLED: 'yes' }) };
const off = { ...readAuthConfig(valid) };

test('the route is the only way in, and it creates rather than signs in', async () => {
  const calls = [];
  const signUp = async (input) => { calls.push(input); return new Response('{}', { status: 200,
    headers: { 'set-cookie': 'session=abc; Path=/; HttpOnly' } }); };
  const devSignIn = createDevSignIn(config, signUp);

  const result = await devSignIn({ email: 'SHOP@Example.Test', password: 'a-long-enough-password' });
  assert.equal(result.outcome, 'created');
  assert.equal(result.cookies.length, 1);
  // Normalised, and the display name is derived, never supplied by the caller.
  assert.deepEqual(calls[0], { email: 'shop@example.test', password: 'a-long-enough-password', name: 'shop' });
});

test('an existing account is refused instead of being signed into', async () => {
  // This is the difference between a test-account tool and a password bypass:
  // if a taken address could be signed into, this route would let anyone set a
  // password on an account they do not own.
  const devSignIn = createDevSignIn(config, async () => new Response('{}', { status: 422 }));
  assert.deepEqual(await devSignIn({ email: 'existing@example.test', password: 'a-long-enough-password' }),
    { outcome: 'exists' });
});

test('only reserved test addresses are accepted', async () => {
  const signUp = async () => { throw new Error('must not be called'); };
  const devSignIn = createDevSignIn(config, signUp);
  for (const email of ['real@gmail.com', 'shop@example.com', 'shop@example.test.evil.com',
    '@example.test', 'shop@sub.example.test', 'shop @example.test']) {
    assert.equal((await devSignIn({ email, password: 'a-long-enough-password' })).outcome, 'invalid', email);
  }
  // Surrounding whitespace and capitals are normalised rather than refused:
  // they cannot change which account is addressed. The sign-up stub throws, so a
  // normalised address reaches it and comes back as a failed attempt rather than
  // as 'invalid' -- which is exactly what proves it was not rejected locally.
  assert.equal((await devSignIn({ email: '  SHOP@Example.Test  ', password: 'a-long-enough-password' })).outcome, 'unavailable');
});

test('a short or malformed password is refused before any account is made', async () => {
  const calls = [];
  const devSignIn = createDevSignIn(config, async (input) => { calls.push(input); return new Response('{}', { status: 200 }); });
  for (const password of ['short', '', 'x'.repeat(11), 'x'.repeat(201), 'has\u0000null']) {
    assert.equal((await devSignIn({ email: 'shop@example.test', password })).outcome, 'invalid');
  }
  assert.equal(calls.length, 0, 'nothing was created');
});

test('extra fields are refused, so a name, role or id cannot be smuggled in', async () => {
  const devSignIn = createDevSignIn(config, async () => new Response('{}', { status: 200 }));
  assert.equal((await devSignIn({ email: 'shop@example.test', password: 'a-long-enough-password', role: 'admin' })).outcome, 'invalid');
  assert.equal((await devSignIn({ email: 'shop@example.test', password: 'a-long-enough-password', name: 'x' })).outcome, 'invalid');
  assert.equal((await devSignIn(null)).outcome, 'invalid');
  assert.equal((await devSignIn([])).outcome, 'invalid');
});

test('when the flag is off the handler does nothing at all', async () => {
  const signUp = async () => { throw new Error('must not be called'); };
  const devSignIn = createDevSignIn(off, signUp);
  assert.deepEqual(await devSignIn({ email: 'shop@example.test', password: 'a-long-enough-password' }),
    { outcome: 'unavailable' });
});

test('the HTTP route refuses cross-origin writes, oversize bodies, and unknown fields', async () => {
  const { createApp } = await import('../../apps/api/dist/app.js');
  const { once } = await import('node:events');
  const created = [];
  // The REAL handler, so the route is tested against the validation that
  // actually runs rather than a permissive stub.
  const real = createDevSignIn(config, async (input) => {
    created.push(input);
    return new Response('{}', { status: 200, headers: { 'set-cookie': 'session=abc; Path=/' } });
  });
  const auth = {
    origin: 'http://localhost:3000', handler: async () => {},
    resolveIdentity: async () => ({ userId: null, cookies: [] }),
    devSignIn: real,
  };
  const server = createApp(auth).listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
  try {
    // Cross-origin is refused before the handler runs.
    let response = await fetch(`${base}/api/v1/dev/sign-in`, { method: 'POST',
      headers: { ...origin, origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'shop@example.test', password: 'a-long-enough-password' }) });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'INVALID_ORIGIN');
    assert.equal(created.length, 0);

    // A body with an extra field never reaches account creation.
    response = await fetch(`${base}/api/v1/dev/sign-in`, { method: 'POST', headers: origin,
      body: JSON.stringify({ email: 'shop@example.test', password: 'a-long-enough-password', role: 'admin' }) });
    assert.equal(response.status, 400);
    assert.equal(created.length, 0);

    // The happy path sets the session cookie and creates the account.
    response = await fetch(`${base}/api/v1/dev/sign-in`, { method: 'POST', headers: origin,
      body: JSON.stringify({ email: 'shop@example.test', password: 'a-long-enough-password' }) });
    assert.equal(response.status, 201);
    assert.deepEqual((await response.json()).data, { created: true });
    assert.match(response.headers.get('set-cookie') ?? '', /session=abc/);
    assert.equal(created.length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('without the flag the route reports that it is unavailable, not that it failed', async () => {
  const { createApp } = await import('../../apps/api/dist/app.js');
  const { once } = await import('node:events');
  // No devSignIn on the runtime: exactly what a server started without
  // DEV_SIGNIN_ENABLED=yes provides.
  const auth = { origin: 'http://localhost:3000', handler: async () => {},
    resolveIdentity: async () => ({ userId: null, cookies: [] }) };
  const server = createApp(auth).listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/dev/sign-in`, {
      method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'shop@example.test', password: 'a-long-enough-password' }) });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'DEV_SIGNIN_UNAVAILABLE');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
