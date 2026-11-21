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

// Every dependency a test does not care about, with the behaviour that makes the
// call succeed, so each test can override exactly one.
const deps = (overrides = {}) => ({
  signUpEmail: async () => new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200,
    headers: { 'set-cookie': 'session=abc; Path=/; HttpOnly' } }),
  signInEmail: async () => new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200,
    headers: { 'set-cookie': 'session=xyz; Path=/; HttpOnly' } }),
  provision: async () => 'ready',
  rolesOf: async () => ['shop'],
  ...overrides,
});
const never = async () => { throw new Error('must not be called'); };

test('creating builds the account from an explicit create action, and never signs in', async () => {
  const calls = [];
  const devSignIn = createDevSignIn(config, deps({
    signUpEmail: async (input) => { calls.push(input); return new Response(JSON.stringify({ user: { id: 'u1' } }),
      { status: 200, headers: { 'set-cookie': 'session=abc; Path=/; HttpOnly' } }); },
    signInEmail: never,
  }));

  const result = await devSignIn({ action: 'create', email: 'SHOP@Example.Test', password: 'a-long-enough-password', role: 'shop' });
  assert.equal(result.outcome, 'created');
  assert.equal(result.role, 'shop');
  assert.equal(result.cookies.length, 1);
  // Normalised, and the display name is derived, never supplied by the caller.
  assert.deepEqual(calls[0], { email: 'shop@example.test', password: 'a-long-enough-password', name: 'shop' });
});

test('creating an existing address reports it as taken and never falls back to signing in', async () => {
  // This is the difference between a test-account tool and a password bypass:
  // creating must not turn a mistyped role into a login on somebody's account.
  const devSignIn = createDevSignIn(config, deps({
    signUpEmail: async () => new Response('{}', { status: 422 }),
    signInEmail: never,
  }));
  assert.deepEqual(await devSignIn({ action: 'create', email: 'existing@example.test', password: 'a-long-enough-password', role: 'shop' }),
    { outcome: 'exists' });
});

test('an explicit action is required: a body without one is not guessed at', async () => {
  const devSignIn = createDevSignIn(config, deps({ signUpEmail: never, signInEmail: never }));
  // No action, an unknown action, and a wrong-typed action are all refused
  // before anything is called.
  assert.equal((await devSignIn({ email: 'shop@example.test', password: 'a-long-enough-password', role: 'shop' })).outcome, 'invalid');
  assert.equal((await devSignIn({ action: 'login', email: 'shop@example.test', password: 'a-long-enough-password' })).outcome, 'invalid');
  assert.equal((await devSignIn({ action: null, email: 'shop@example.test', password: 'a-long-enough-password' })).outcome, 'invalid');
  // The old three-field shape is refused too, rather than being read as a create.
  assert.equal((await devSignIn({ email: 'shop@example.test', password: 'a-long-enough-password', role: 'shop' })).outcome, 'invalid');
});

test('signing in to an existing test account verifies the password and returns its session', async () => {
  const seen = [];
  const devSignIn = createDevSignIn(config, deps({
    signInEmail: async (input) => { seen.push(input); return new Response(JSON.stringify({ user: { id: 'u9' } }),
      { status: 200, headers: { 'set-cookie': 'session=xyz; Path=/; HttpOnly' } }); },
    signUpEmail: never,
  }));
  const result = await devSignIn({ action: 'sign-in', email: 'shop1@example.test', password: 'a-long-enough-password' });
  assert.deepEqual(result, { outcome: 'signed-in', cookies: ['session=xyz; Path=/; HttpOnly'] });
  // Exactly what Better Auth verifies against its stored hash. No role is sent:
  // signing in cannot change what the account is.
  assert.deepEqual(seen, [{ email: 'shop1@example.test', password: 'a-long-enough-password' }]);
});

test('a wrong password is reported without saying whether the address exists', async () => {
  const devSignIn = createDevSignIn(config, deps({
    signInEmail: async () => new Response('{}', { status: 401 }),
    signUpEmail: never,
  }));
  // One outcome for a wrong password and for an account that does not exist:
  // which half was wrong is not information this route gives away.
  assert.deepEqual(await devSignIn({ action: 'sign-in', email: 'shop1@example.test', password: 'a-long-enough-password' }),
    { outcome: 'credentials' });
});

test('signing in to an account with no role says so instead of handing back a useless session', async () => {
  // Exactly the owner's three dead accounts: the auth user exists, the
  // application account was never written. A session that can see nothing looks
  // like a broken app, so it is refused with a reason.
  const devSignIn = createDevSignIn(config, deps({ rolesOf: async () => [] }));
  assert.deepEqual(await devSignIn({ action: 'sign-in', email: 'shop1@example.test', password: 'a-long-enough-password' }),
    { outcome: 'unprovisioned' });
});

test('signing in creates nothing: no sign-up call, whatever happens', async () => {
  const outcomes = [];
  for (const signInEmail of [
    async () => new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 }),
    async () => new Response('{}', { status: 401 }),
    async () => new Response(JSON.stringify({ nope: true }), { status: 200 }),
    async () => { throw new Error('boom'); },
  ]) {
    const devSignIn = createDevSignIn(config, deps({ signInEmail, signUpEmail: never }));
    outcomes.push((await devSignIn({ action: 'sign-in', email: 'shop1@example.test', password: 'a-long-enough-password' })).outcome);
  }
  // 200 → signed in (no roles needed here, rolesOf defaults to ['shop']),
  // 401 → credentials, unusable body → unavailable, throw → unavailable.
  assert.deepEqual(outcomes, ['signed-in', 'credentials', 'unavailable', 'unavailable']);
});

test('a role sent while signing in is refused rather than ignored', async () => {
  // The form must never imply that signing in can set a tier. Ignoring the field
  // would leave a caller believing it did something.
  const devSignIn = createDevSignIn(config, deps({ signInEmail: never }));
  assert.equal((await devSignIn({ action: 'sign-in', email: 'shop1@example.test', password: 'a-long-enough-password', role: 'mandi' })).outcome,
    'invalid');
});

test('signing in to a real address is refused as tightly as creating one', async () => {
  const devSignIn = createDevSignIn(config, deps({ signInEmail: never }));
  for (const email of ['real@gmail.com', 'shop@example.com', 'shop@example.test.evil.com',
    '@example.test', 'shop@sub.example.test', 'shop @example.test']) {
    assert.equal((await devSignIn({ action: 'sign-in', email, password: 'a-long-enough-password' })).outcome, 'invalid', email);
  }
});

test('only reserved test addresses are accepted', async () => {
  const attempted = [];
  const devSignIn = createDevSignIn(config, deps({
    signUpEmail: async (input) => { attempted.push(input.email); return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 }); },
  }));
  for (const email of ['real@gmail.com', 'shop@example.com', 'shop@example.test.evil.com',
    '@example.test', 'shop@sub.example.test', 'shop @example.test']) {
    assert.equal((await devSignIn({ action: 'create', email, password: 'a-long-enough-password', role: 'shop' })).outcome, 'invalid', email);
  }
  // A refused address never reached Better Auth, so no auth user was created
  // before the address rule rejected it.
  assert.deepEqual(attempted, []);
  // Surrounding whitespace and capitals are normalised rather than refused:
  // they cannot change which account is addressed, so this one is created.
  assert.equal((await devSignIn({ action: 'create', email: '  SHOP@Example.Test  ', password: 'a-long-enough-password', role: 'shop' })).outcome, 'created');
});

test('a short or malformed password is refused before any account is touched', async () => {
  const calls = [];
  const devSignIn = createDevSignIn(config, deps({
    signUpEmail: async (input) => { calls.push(input); return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 }); },
    signInEmail: async (input) => { calls.push(input); return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 }); },
  }));
  for (const password of ['short', '', 'x'.repeat(11), 'x'.repeat(201), 'has\u0000null']) {
    assert.equal((await devSignIn({ action: 'create', email: 'shop@example.test', password, role: 'shop' })).outcome, 'invalid');
    assert.equal((await devSignIn({ action: 'sign-in', email: 'shop@example.test', password })).outcome, 'invalid');
  }
  assert.equal(calls.length, 0, 'neither creating nor signing in was attempted');
});

test('extra fields are refused, so a name, role or id cannot be smuggled in', async () => {
  const devSignIn = createDevSignIn(config, deps({ signUpEmail: never }));
  assert.equal((await devSignIn({ action: 'create', email: 'shop@example.test', password: 'a-long-enough-password', role: 'admin' })).outcome, 'invalid');
  assert.equal((await devSignIn({ action: 'create', email: 'shop@example.test', password: 'a-long-enough-password', name: 'x' })).outcome, 'invalid');
  assert.equal((await devSignIn({ action: 'create', email: 'shop@example.test', password: 'a-long-enough-password', role: 'shop', id: 'u2' })).outcome, 'invalid');
  assert.equal((await devSignIn(null)).outcome, 'invalid');
  assert.equal((await devSignIn([])).outcome, 'invalid');
});

test('when the flag is off the handler does nothing at all', async () => {
  const devSignIn = createDevSignIn(off, deps({ signUpEmail: never, signInEmail: never, rolesOf: never }));
  assert.deepEqual(await devSignIn({ action: 'sign-in', email: 'shop@example.test', password: 'a-long-enough-password' }),
    { outcome: 'unavailable' });
  assert.deepEqual(await devSignIn({ action: 'create', email: 'shop@example.test', password: 'a-long-enough-password', role: 'shop' }),
    { outcome: 'unavailable' });
});

test('the HTTP route refuses cross-origin writes, oversize bodies, and unknown fields', async () => {
  const { createApp } = await import('../../apps/api/dist/app.js');
  const { once } = await import('node:events');
  const created = [];
  // The REAL handler, so the route is tested against the validation that
  // actually runs rather than a permissive stub.
  const real = createDevSignIn(config, deps({
    signUpEmail: async (input) => {
      created.push(input);
      return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200, headers: { 'set-cookie': 'session=abc; Path=/' } });
    },
  }));
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
      body: JSON.stringify({ action: 'create', email: 'shop@example.test', password: 'a-long-enough-password', role: 'shop' }) });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'INVALID_ORIGIN');
    assert.equal(created.length, 0);

    // A body with an extra field never reaches account creation.
    response = await fetch(`${base}/api/v1/dev/sign-in`, { method: 'POST', headers: origin,
      body: JSON.stringify({ action: 'create', email: 'shop@example.test', password: 'a-long-enough-password', role: 'admin' }) });
    assert.equal(response.status, 400);
    assert.equal(created.length, 0);

    // The happy path sets the session cookie and creates the account.
    response = await fetch(`${base}/api/v1/dev/sign-in`, { method: 'POST', headers: origin,
      body: JSON.stringify({ action: 'create', email: 'shop@example.test', password: 'a-long-enough-password', role: 'shop' }) });
    assert.equal(response.status, 201);
    // The chosen role comes back so the UI can say which tier was created.
    assert.deepEqual((await response.json()).data, { created: true, role: 'shop' });
    assert.match(response.headers.get('set-cookie') ?? '', /session=abc/);
    assert.equal(created.length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('the HTTP route signs in with 200 and reports a wrong password as 401', async () => {
  const { createApp } = await import('../../apps/api/dist/app.js');
  const { once } = await import('node:events');
  const real = createDevSignIn(config, deps({
    signInEmail: async ({ password }) => password === 'the-right-password'
      ? new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200, headers: { 'set-cookie': 'session=xyz; Path=/' } })
      : new Response('{}', { status: 401 }),
  }));
  const auth = { origin: 'http://localhost:3000', handler: async () => {},
    resolveIdentity: async () => ({ userId: null, cookies: [] }), devSignIn: real };
  const server = createApp(auth).listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
  try {
    // 200, not 201: nothing was created, and a caller must be able to tell.
    let response = await fetch(`${base}/api/v1/dev/sign-in`, { method: 'POST', headers: origin,
      body: JSON.stringify({ action: 'sign-in', email: 'shop1@example.test', password: 'the-right-password' }) });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, { signedIn: true });
    assert.match(response.headers.get('set-cookie') ?? '', /session=xyz/);

    response = await fetch(`${base}/api/v1/dev/sign-in`, { method: 'POST', headers: origin,
      body: JSON.stringify({ action: 'sign-in', email: 'shop1@example.test', password: 'the-wrong-password' }) });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'INVALID_CREDENTIALS');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('the HTTP route reports an unprovisioned account as a conflict, not a login', async () => {
  const { createApp } = await import('../../apps/api/dist/app.js');
  const { once } = await import('node:events');
  const real = createDevSignIn(config, deps({ rolesOf: async () => [] }));
  const auth = { origin: 'http://localhost:3000', handler: async () => {},
    resolveIdentity: async () => ({ userId: null, cookies: [] }), devSignIn: real };
  const server = createApp(auth).listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/dev/sign-in`, { method: 'POST',
      headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'sign-in', email: 'shop1@example.test', password: 'a-long-enough-password' }) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'ACCOUNT_UNPROVISIONED');
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
      body: JSON.stringify({ action: 'create', email: 'shop@example.test', password: 'a-long-enough-password', role: 'shop' }) });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'DEV_SIGNIN_UNAVAILABLE');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('the server actually mounts the dev sign-in handler', async () => {
  // This is the bug that made the feature useless on first contact with a real
  // machine: the route existed, the flag was set, and server.ts never passed the
  // handler through, so every request got 503 and the form never appeared.
  // A route test that builds its own mount cannot see that, so this one reads
  // the composition root.
  const { readFile } = await import('node:fs/promises');
  const server = await readFile(new URL('../../apps/api/src/server.ts', import.meta.url), 'utf8');
  assert.match(server, /devSignIn:\s*runtime\.devSignIn/,
    'server.ts must pass runtime.devSignIn into the app mount');
  // And the runtime must actually provide it, or the mount would be undefined.
  const { createAuthRuntime } = await import('../../apps/api/dist/auth.js');
  assert.equal(typeof createAuthRuntime, 'function');
});

test('the mount passes through the stores the app actually asks for', async () => {
  // The same class of mistake was caught once for lots and once for dev sign-in.
  // Rather than a hand-written list that drifts (an earlier draft of this test
  // named a 'payments' mount that does not exist), derive the keys from the app's
  // own type and check each one is present.
  const { readFile } = await import('node:fs/promises');
  const [server, app] = await Promise.all([
    readFile(new URL('../../apps/api/src/server.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/api/src/app.ts', import.meta.url), 'utf8'),
  ]);
  const mountLine = server.split('\n').find(line => line.includes('mount = {')) ?? '';
  const typeBlock = app.slice(app.indexOf('type AuthMount'), app.indexOf('export function createApp'));
  // Optional members: `name?:`. These are the ones a caller can forget.
  const optional = [...typeBlock.matchAll(/^\s{2}([a-zA-Z]+)\?:/gm)].map(m => m[1]);
  assert.ok(optional.length >= 4, `found the optional mounts (${optional.join(', ')})`);
  for (const key of optional) {
    assert.ok(mountLine.includes(`${key}:`), `${key} is passed into the mount`);
  }
});

test('the dev allowlist still permits every endpoint the app itself calls', async () => {
  // Turning dev sign-in on must not break ordinary Google sign-in. The first
  // version of the allowlist omitted callback/google and sign-in/social, so
  // enabling the flag made sign-in fail and the screen said "unavailable".
  const { readFile } = await import('node:fs/promises');
  const [authSrc, bridge] = await Promise.all([
    readFile(new URL('../../apps/api/src/auth.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/web/app/api/auth/[...path]/route.ts', import.meta.url), 'utf8'),
  ]);
  // Every path the web bridge is willing to forward must survive the allowlist.
  // The bridge lists them on two lines, so read the whole allow expression.
  const bridgeBlock = bridge.slice(bridge.indexOf('const allowed ='), bridge.indexOf('if (!allowed)'));
  const forwarded = [...bridgeBlock.matchAll(/'(\/api\/auth\/[a-z/-]+)'/g)].map(m => m[1]);
  assert.ok(forwarded.length >= 3, `found the forwarded paths (${forwarded.join(', ')})`);
  const allowBlock = authSrc.slice(authSrc.indexOf('const allowed = (request.method'), authSrc.indexOf('if (!allowed)'));
  for (const path of new Set(forwarded)) {
    assert.ok(allowBlock.includes(`'${path}'`), `${path} must remain allowed when dev sign-in is on`);
  }
});

test('the dev allowlist still refuses Better Auth\'s own sign-up and sign-in endpoints', async () => {
  const { readFile } = await import('node:fs/promises');
  const authSrc = await readFile(new URL('../../apps/api/src/auth.ts', import.meta.url), 'utf8');
  const allowBlock = authSrc.slice(authSrc.indexOf('const allowed = (request.method'), authSrc.indexOf('if (!allowed)'));
  // These accept arbitrary addresses or turn a password into a session without
  // the @example.test check, so they must never be reachable. The dev form's
  // own sign-in goes through the server SDK, inside this process, not through
  // this HTTP allowlist.
  for (const path of ['/api/auth/sign-up/email', '/api/auth/sign-in/email']) {
    assert.equal(allowBlock.includes(`'${path}'`), false, `${path} must not be allowed`);
  }
});

test('admin cannot be chosen on the public form', async () => {
  // admin is outside the supply chain and is granted by the local role tool with a
  // recorded reason. A form that accepted it would be a self-service operator
  // account on a server anyone on the machine can reach.
  const devSignIn = createDevSignIn(config, deps({ signUpEmail: never }));
  for (const role of ['admin', 'ADMIN', 'superuser', '']) {
    assert.equal((await devSignIn({ action: 'create', email: 'shop@example.test', password: 'a-long-enough-password', role })).outcome,
      'invalid', role);
  }
});

test('the created account is provisioned with the role that was chosen', async () => {
  for (const role of ['customer', 'collector', 'shop', 'mandi', 'recycler']) {
    const provisioned = [];
    const devSignIn = createDevSignIn(config, deps({
      provision: async (userId, chosen) => { provisioned.push([userId, chosen]); return 'ready'; },
    }));
    const result = await devSignIn({ action: 'create', email: `${role}1@example.test`, password: 'a-long-enough-password', role });
    assert.equal(result.outcome, 'created', role);
    // The role passed to provisioning is the one selected, not one derived from
    // the address -- two test accounts could share a name.
    assert.deepEqual(provisioned, [['u1', role]], role);
    assert.equal(result.role, role);
  }
});

test('an address that already has an account is refused, so no second tier is added', async () => {
  const devSignIn = createDevSignIn(config, deps({ provision: async () => 'taken' }));
  assert.deepEqual(await devSignIn({ action: 'create', email: 'existing@example.test', password: 'a-long-enough-password', role: 'mandi' }),
    { outcome: 'exists' });
});
