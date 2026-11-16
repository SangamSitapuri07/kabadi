// Synthetic integration: disposable DB, real app API and web bridge, no Google calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import pg from 'pg';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import EmbeddedPostgres from 'embedded-postgres';
import { createAuthRuntime } from '../../apps/api/dist/auth.js';
import { createApp } from '../../apps/api/dist/app.js';
import { requireRoles } from '../../apps/api/dist/authorization.js';
import { createAccountLookup, migrateAccountStore } from '../../apps/api/dist/account-store.js';
import express from 'express';

async function port() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit'); child.kill('SIGTERM'); await done;
}

test('app integration: migration, web bridge and Google-only initiation', { timeout: 120000 }, async () => {
  const root = resolve(import.meta.dirname, '../..');
  const scratch = resolve(root, '../.cache');
  await mkdir(scratch, { recursive: true });
  const temp = await mkdtemp(join(scratch, 'app-auth-test-'));
  const password = randomBytes(24).toString('hex');
  const dbPort = await port();
  const webPort = await port();
  const publicOrigin = `http://127.0.0.1:${webPort}`;
  const db = new EmbeddedPostgres({ databaseDir: join(temp, 'db'), user: 'postgres', password, port: dbPort,
    authMethod: 'scram-sha-256', persistent: false, autoRehydrateSymlinks: true,
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', `unix_socket_directories=${temp}`],
    onLog: () => {}, onError: () => {} });
  let started = false, runtime, api, web, serverProcess, accountPool;
  try {
    await db.initialise(); await db.start(); started = true;
    const databaseURL = `postgres://postgres:${password}@127.0.0.1:${dbPort}/postgres`;
    const secret = randomBytes(32).toString('hex');
    const env = { ...process.env, NODE_ENV: 'development', AUTH_ENABLED: 'true', AUTH_PUBLIC_ORIGIN: publicOrigin,
      DATABASE_URL: databaseURL, BETTER_AUTH_SECRET: secret, GOOGLE_CLIENT_ID: 'fake-google-client', GOOGLE_CLIENT_SECRET: 'fake-google-secret', PORT: String(await port()) };
    delete env.AUTH_MIGRATION_CONFIRM;
    delete env.AUTHORIZATION_MIGRATION_CONFIRM;
    accountPool = new pg.Pool({ connectionString: databaseURL, max: 2 });
    const accountMigration = (overrides = {}) => spawnSync(process.execPath, ['apps/api/dist/migrate-account-store.js'],
      { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 20000 });
    assert.equal(accountMigration().status, 1, 'authorization migration must require explicit confirmation');
    assert.equal(accountMigration({ AUTHORIZATION_MIGRATION_CONFIRM: 'yes' }).status, 1, 'auth schema must already exist');
    assert.equal(accountMigration({ AUTHORIZATION_MIGRATION_CONFIRM: 'yes', NODE_ENV: 'production' }).status, 1);
    await assert.rejects(migrateAccountStore(accountPool));
    assert.equal((await accountPool.query("SELECT to_regnamespace('kabadi_authz') AS schema")).rows[0].schema, null, 'failed migration rolls back all schema changes');
    runtime = createAuthRuntime({ origin: publicOrigin, databaseURL, secret,
      googleClientId: 'fake-google-client', googleClientSecret: 'fake-google-secret' });
    assert.ok((await runtime.schemaStatus()).missing > 0);
    const beforeMigration = spawnSync(process.execPath, ['apps/api/dist/server.js'], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(beforeMigration.status, 1, 'API must not start without auth schema');
    const refused = spawnSync(process.execPath, ['apps/api/dist/migrate-auth.js'], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(refused.status, 1, 'migration must require explicit confirmation');
    const migration = spawnSync(process.execPath, ['apps/api/dist/migrate-auth.js'], { cwd: root, env: { ...env, AUTH_MIGRATION_CONFIRM: 'yes' }, encoding: 'utf8', timeout: 20000 });
    assert.equal(migration.status, 0, 'explicit isolated migration should succeed');
    assert.deepEqual(await runtime.schemaStatus(), { missing: 0, problems: 0 });
    await runtime.migrate();
    // Refuse an unrelated preexisting schema rather than adopting or overwriting it.
    await accountPool.query('CREATE SCHEMA kabadi_authz');
    assert.equal(accountMigration({ AUTHORIZATION_MIGRATION_CONFIRM: 'yes' }).status, 1);
    await accountPool.query('DROP SCHEMA kabadi_authz');
    assert.equal(accountMigration({ AUTHORIZATION_MIGRATION_CONFIRM: 'yes' }).status, 0);
    // Re-running the explicit migration is a no-op for the recognized version.
    assert.equal(accountMigration({ AUTHORIZATION_MIGRATION_CONFIRM: 'yes' }).status, 0);
    assert.equal((await accountPool.query('SELECT count(*)::int AS count FROM kabadi_authz.accounts')).rows[0].count, 0);
    assert.equal((await accountPool.query('SELECT count(*)::int AS count FROM kabadi_authz.role_grants')).rows[0].count, 0);
    serverProcess = spawn(process.execPath, ['apps/api/dist/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('API startup timed out')), 10000);
      serverProcess.stdout.on('data', chunk => { if (String(chunk).includes('API listening on port')) { clearTimeout(timer); resolve(); } });
      serverProcess.once('exit', code => { clearTimeout(timer); reject(new Error(`API startup failed: ${code}`)); });
      serverProcess.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const serverSession = await fetch(`http://127.0.0.1:${env.PORT}/api/auth/get-session`);
    assert.equal(serverSession.status, 200);
    assert.deepEqual(await serverSession.json(), { authenticated: false });
    const serverOnboarding = await fetch(`http://127.0.0.1:${env.PORT}/api/v1/account/customer`, {
      method: 'POST', headers: { origin: publicOrigin, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(serverOnboarding.status, 401, 'actual API process must resolve the session');
    await stop(serverProcess);
    api = createApp({ origin: publicOrigin, handler: runtime.handler, resolveIdentity: runtime.resolveIdentity, onboardCustomer: runtime.onboardCustomer }).listen(0, '127.0.0.1');
    await once(api, 'listening');
    const apiOrigin = `http://127.0.0.1:${api.address().port}`;
    web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', 'apps/web', '-H', '127.0.0.1', '-p', String(webPort)],
      { cwd: root, env: { ...process.env, AUTH_PUBLIC_ORIGIN: publicOrigin, API_INTERNAL_ORIGIN: apiOrigin, NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Web startup timed out')), 20000);
      const onData = chunk => { if (String(chunk).includes('Ready in')) { clearTimeout(timer); resolve(); } };
      web.stdout.on('data', onData); web.stderr.on('data', onData);
      web.once('exit', code => { clearTimeout(timer); reject(new Error(`Web startup failed: ${code}`)); });
      web.once('error', err => { clearTimeout(timer); reject(err); });
    });
    const signInPath = '/api/auth/sign-in/social';
    const payload = JSON.stringify({ provider: 'google', callbackURL: '/' });
    for (const endpoint of [apiOrigin, publicOrigin]) {
      for (const origin of [undefined, 'https://evil.example']) {
        const headers = { 'content-type': 'application/json' }; if (origin) headers.origin = origin;
        assert.equal((await fetch(endpoint + signInPath, { method: 'POST', headers, body: payload })).status, 403);
      }
    }
    const signIn = await fetch(publicOrigin + signInPath, { method: 'POST', headers: { 'content-type': 'application/json', origin: publicOrigin }, body: payload });
    assert.equal(signIn.status, 200);
    assert.equal(signIn.headers.get('cache-control'), 'no-store');
    const data = await signIn.json();
    const googleURL = new URL(data.url);
    assert.equal(googleURL.origin, 'https://accounts.google.com');
    assert.equal(googleURL.searchParams.get('client_id'), 'fake-google-client');
    assert.equal(googleURL.searchParams.get('redirect_uri'), `${publicOrigin}/api/auth/callback/google`);
    assert.ok(googleURL.searchParams.get('state'));
    const cookies = signIn.headers.getSetCookie();
    assert.ok(cookies.length > 0);
    assert.ok(cookies.some(cookie => /httponly/i.test(cookie) && /samesite=lax/i.test(cookie)));
    assert.equal(googleURL.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(googleURL.searchParams.get('code_challenge'));
    const session = await fetch(publicOrigin + '/api/auth/get-session');
    assert.equal(session.status, 200); assert.deepEqual(await session.json(), { authenticated: false });
    // A synthetic DB user/session and signed cookie exercise real server-side
    // lookup and sign-out without an external identity provider or real data.
    const client = new pg.Client({ connectionString: databaseURL });
    await client.connect();
    try {
      const userId = randomBytes(16).toString('hex');
      const token = randomBytes(32).toString('hex');
      await client.query('INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, false, NOW(), NOW())', [userId, 'Synthetic', `${userId}@example.test`]);
      await client.query('INSERT INTO "session" (id, "userId", token, "expiresAt", "createdAt", "updatedAt") VALUES ($1, $2, $3, NOW() + INTERVAL \'1 hour\', NOW() - INTERVAL \'2 days\', NOW() - INTERVAL \'2 days\')', [randomBytes(16).toString('hex'), userId, token]);
      const signature = createHmac('sha256', secret).update(token).digest('base64');
      const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
      // The server-side resolver gets identity only from the validated session;
      // it is not a role or account authorization decision.
      assert.equal((await runtime.resolveIdentity()).userId, null);
      assert.equal((await runtime.resolveIdentity('better-auth.session_token=invalid')).userId, null);
      const sessionWithCookie = () => fetch(publicOrigin + '/api/auth/get-session', { headers: { cookie } });
      const validSession = await sessionWithCookie();
      assert.equal(validSession.status, 200);
      assert.deepEqual(await validSession.json(), { authenticated: true });
      assert.ok(validSession.headers.getSetCookie().some(value => value.includes('better-auth.session_token=')), 'session refresh cookie must cross both layers');
      const identity = await runtime.resolveIdentity(cookie);
      assert.equal(identity.userId, userId);
      // Exercise the actual narrow customer onboarding route through both
      // boundaries. Only the validated cookie may select the account.
      const customerPath = '/api/v1/account/customer';
      const post = (base, body = '{}', origin = publicOrigin, extraHeaders = {}) => fetch(base + customerPath, {
        method: 'POST', headers: { origin, 'content-type': 'application/json', ...extraHeaders }, body,
      });
      const lookupAccount = createAccountLookup(accountPool);
      assert.equal(await lookupAccount(userId), null);
      for (const base of [apiOrigin, publicOrigin]) {
        assert.equal((await post(base, '{}', 'https://evil.example', { cookie })).status, 403);
        assert.equal((await post(base)).status, 401);
        assert.equal((await post(base, JSON.stringify({ role: 'admin', userId: 'someone' }), publicOrigin, { cookie })).status, 400);
        assert.equal((await post(base, 'x'.repeat(1025), publicOrigin, { cookie })).status, 413);
      }
      // A failure while creating the role must roll back the account too.
      await client.query("ALTER TABLE kabadi_authz.role_grants ADD CONSTRAINT test_reject_customer CHECK (role <> 'customer')");
      try {
        assert.equal((await post(publicOrigin, '{}', publicOrigin, { cookie })).status, 503);
        assert.equal(await lookupAccount(userId), null);
      } finally { await client.query('ALTER TABLE kabadi_authz.role_grants DROP CONSTRAINT test_reject_customer'); }
      const attempts = await Promise.all(Array.from({ length: 4 }, () => post(publicOrigin, '{}', publicOrigin, { cookie, 'x-role': 'admin', 'x-user-id': 'someone' })));
      for (const result of attempts) {
        assert.equal(result.status, 200);
        assert.deepEqual(await result.json(), { data: { customer: 'ready' } });
        assert.equal(result.headers.get('cache-control'), 'no-store');
      }
      assert.deepEqual(await lookupAccount(userId), { status: 'active', roles: ['customer'] });
      await client.query("UPDATE kabadi_authz.accounts SET status = 'suspended' WHERE user_id = $1", [userId]);
      assert.equal((await post(publicOrigin, '{}', publicOrigin, { cookie })).status, 403);
      assert.deepEqual(await lookupAccount(userId), { status: 'suspended', roles: ['customer'] });
      await client.query("UPDATE kabadi_authz.accounts SET status = 'active' WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM kabadi_authz.role_grants WHERE user_id = $1", [userId]);
      await client.query("INSERT INTO kabadi_authz.role_grants VALUES ($1, 'admin')", [userId]);
      assert.equal((await post(publicOrigin, '{}', publicOrigin, { cookie })).status, 403);
      assert.deepEqual(await lookupAccount(userId), { status: 'active', roles: ['admin'] });
      await client.query('DELETE FROM kabadi_authz.accounts WHERE user_id = $1', [userId]);
      assert.equal(await lookupAccount(userId), null);
      // Test-only route with a real Better Auth session and PostgreSQL lookup.
      // SQL writes here are synthetic test setup, not a provisioning API.
      await assert.rejects(client.query("INSERT INTO kabadi_authz.accounts VALUES ($1, 'active')", ['no-such-user']), { code: '23503' });
      await assert.rejects(client.query("INSERT INTO kabadi_authz.accounts VALUES ($1, 'bad')", [userId]), { code: '23514' });
      await client.query("INSERT INTO kabadi_authz.accounts VALUES ($1, 'active')", [userId]);
      assert.deepEqual(await lookupAccount(userId), { status: 'active', roles: [] });
      await assert.rejects(client.query("INSERT INTO kabadi_authz.role_grants VALUES ($1, 'superuser')", [userId]), { code: '23514' });
      await assert.rejects(client.query("INSERT INTO kabadi_authz.role_grants VALUES ($1, 'admin')", ['no-such-user']), { code: '23503' });
      await client.query("INSERT INTO kabadi_authz.role_grants VALUES ($1, 'customer')", [userId]);
      await assert.rejects(client.query("INSERT INTO kabadi_authz.role_grants VALUES ($1, 'customer')", [userId]), { code: '23505' });
      assert.deepEqual(await lookupAccount(userId), { status: 'active', roles: ['customer'] });
      await migrateAccountStore(accountPool);
      assert.deepEqual(await lookupAccount(userId), { status: 'active', roles: ['customer'] }, 're-run must retain data');
      const protectedApp = express();
      protectedApp.get('/protected', requireRoles({ resolveIdentity: runtime.resolveIdentity, lookupAccount }, ['customer']),
      (_req, res) => res.json({ ok: true }));
      const protectedServer = protectedApp.listen(0, '127.0.0.1');
      await once(protectedServer, 'listening');
      try {
        const url = `http://127.0.0.1:${protectedServer.address().port}/protected`;
        assert.equal((await fetch(url)).status, 401);
        // Earlier session lookups refreshed it; age it again to exercise the
        // guard's refresh-cookie forwarding through a real session lookup.
        await client.query('UPDATE "session" SET "updatedAt" = NOW() - INTERVAL \'2 days\', "expiresAt" = NOW() + INTERVAL \'1 hour\' WHERE token = $1', [token]);
        const allowed = await fetch(url, { headers: { cookie } });
        assert.equal(allowed.status, 200);
        assert.ok(allowed.headers.getSetCookie().some(value => value.includes('better-auth.session_token=')));
        await client.query("UPDATE kabadi_authz.accounts SET status = 'suspended' WHERE user_id = $1", [userId]);
        assert.equal((await fetch(url, { headers: { cookie } })).status, 403);
        await client.query("UPDATE kabadi_authz.accounts SET status = 'active' WHERE user_id = $1", [userId]);
        await client.query("DELETE FROM kabadi_authz.role_grants WHERE user_id = $1 AND role = 'customer'", [userId]);
        await client.query("INSERT INTO kabadi_authz.role_grants VALUES ($1, 'admin')", [userId]);
        assert.equal((await fetch(url, { headers: { cookie, 'x-role': 'customer' } })).status, 403);
        // A missing schema must become a sanitized failure, never a grant.
        await client.query('ALTER SCHEMA kabadi_authz RENAME TO kabadi_authz_unavailable');
        try {
          const unavailableAccount = await fetch(url, { headers: { cookie } });
          assert.equal(unavailableAccount.status, 503);
          assert.deepEqual(await unavailableAccount.json(), { error: { code: 'AUTHORIZATION_UNAVAILABLE', message: 'Access is unavailable.' } });
        } finally { await client.query('ALTER SCHEMA kabadi_authz_unavailable RENAME TO kabadi_authz'); }
        await client.query('DELETE FROM kabadi_authz.accounts WHERE user_id = $1', [userId]);
        assert.equal((await fetch(url, { headers: { cookie } })).status, 403);
        assert.equal((await client.query('SELECT count(*)::int AS count FROM kabadi_authz.role_grants WHERE user_id = $1', [userId])).rows[0].count, 0);
      } finally { await new Promise(resolve => protectedServer.close(resolve)); }
      // The directly reachable API must not expose the bearer token or user.
      const directSession = await fetch(apiOrigin + '/api/auth/get-session', { headers: { cookie } });
      assert.equal(directSession.status, 200);
      assert.equal(directSession.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await directSession.json(), { authenticated: true });
      const invalidCookie = await fetch(apiOrigin + '/api/auth/get-session', { headers: { cookie: 'better-auth.session_token=invalid' } });
      assert.deepEqual(await invalidCookie.json(), { authenticated: false });
      const badSignOut = await fetch(publicOrigin + '/api/auth/sign-out', { method: 'POST', headers: { origin: 'https://evil.example', cookie, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(badSignOut.status, 403);
      assert.deepEqual(await (await sessionWithCookie()).json(), { authenticated: true });
      const signOut = await fetch(publicOrigin + '/api/auth/sign-out', { method: 'POST', headers: { origin: publicOrigin, cookie, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(signOut.status, 200);
      assert.equal((await client.query('SELECT count(*)::int AS count FROM "session" WHERE token = $1', [token])).rows[0].count, 0);
      assert.deepEqual(await (await sessionWithCookie()).json(), { authenticated: false }, 'replayed old cookie must not authenticate');
      assert.equal((await runtime.resolveIdentity(cookie)).userId, null, 'revoked session must not resolve an identity');
      assert.equal((await post(publicOrigin, '{}', publicOrigin, { cookie })).status, 401, 'revoked session cannot onboard');
      const expiredToken = randomBytes(32).toString('hex');
      await client.query('INSERT INTO "session" (id, "userId", token, "expiresAt", "createdAt", "updatedAt") VALUES ($1, $2, $3, NOW() - INTERVAL \'1 hour\', NOW() - INTERVAL \'2 days\', NOW() - INTERVAL \'2 days\')', [randomBytes(16).toString('hex'), userId, expiredToken]);
      const expiredSignature = createHmac('sha256', secret).update(expiredToken).digest('base64');
      const expiredCookie = `better-auth.session_token=${encodeURIComponent(`${expiredToken}.${expiredSignature}`)}`;
      assert.equal((await runtime.resolveIdentity(expiredCookie)).userId, null, 'expired session must not resolve an identity');
    } finally { await client.end(); }
    const wrongProvider = await fetch(publicOrigin + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: publicOrigin }, body: '{}' });
    assert.equal(wrongProvider.status, 404);
    const sensitiveState = `synthetic-${randomBytes(16).toString('hex')}`;
    const captured = [];
    const originalError = console.error;
    let badCallback;
    try {
      console.error = (...args) => captured.push(args.map(String).join(' '));
      badCallback = await fetch(`${publicOrigin}/api/auth/callback/google?code=fake&state=${sensitiveState}`, { redirect: 'manual' });
    } finally { console.error = originalError; }
    assert.ok(badCallback.status >= 300 && badCallback.status < 400);
    const failureLocation = new URL(badCallback.headers.get('location'));
    assert.equal(failureLocation.origin, publicOrigin);
    assert.equal(failureLocation.pathname, '/api/auth/error');
    const errorRedirect = await fetch(failureLocation, { redirect: 'manual' });
    assert.equal(errorRedirect.status, 303);
    assert.equal(errorRedirect.headers.get('location'), '/auth/error');
    assert.equal((await fetch(publicOrigin + errorRedirect.headers.get('location'))).status, 200);
    assert.ok(captured.length > 0, 'invalid state should produce a sanitized diagnostic');
    assert.ok(!captured.join('\n').includes(sensitiveState));
    const tooLarge = await fetch(publicOrigin + signInPath, { method: 'POST', headers: { origin: publicOrigin, 'content-type': 'application/json' }, body: 'x'.repeat(8193) });
    assert.equal(tooLarge.status, 413);
    await new Promise(resolve => api.close(resolve)); api = undefined;
    const unavailable = await fetch(publicOrigin + '/api/auth/get-session');
    assert.equal(unavailable.status, 503);
    assert.ok(!(await unavailable.text()).includes(password));
    // Verify the bridge projects only the boolean and rejects malformed status.
    let mode = 'valid';
    const mock = createHttpServer((_req, res) => {
      if (mode === 'error') { res.writeHead(500); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'synthetic=refresh; HttpOnly; SameSite=Lax' });
      const body = mode === 'valid' ? { authenticated: true, token: 'synthetic-secret', user: { name: 'private' } } :
        mode === 'customer' ? { data: { customer: 'ready', userId: 'private' }, token: 'synthetic-secret' } : { authenticated: 'yes' };
      res.end(JSON.stringify(body));
    });
    mock.listen(Number(new URL(apiOrigin).port), '127.0.0.1');
    await once(mock, 'listening');
    try {
      const projected = await fetch(publicOrigin + '/api/auth/get-session');
      assert.deepEqual(await projected.json(), { authenticated: true });
      assert.ok(projected.headers.getSetCookie().some(value => value.includes('synthetic=refresh')));
      mode = 'customer';
      const customerProjection = await fetch(publicOrigin + '/api/v1/account/customer', { method: 'POST', headers: { origin: publicOrigin, 'content-type': 'application/json' }, body: '{}' });
      assert.deepEqual(await customerProjection.json(), { data: { customer: 'ready' } });
      assert.ok(customerProjection.headers.getSetCookie().some(value => value.includes('synthetic=refresh')));
      mode = 'invalid';
      assert.equal((await fetch(publicOrigin + '/api/v1/account/customer', { method: 'POST', headers: { origin: publicOrigin, 'content-type': 'application/json' }, body: '{}' })).status, 503);
      assert.equal((await fetch(publicOrigin + '/api/auth/get-session')).status, 503);
      mode = 'error';
      assert.equal((await fetch(publicOrigin + '/api/auth/get-session')).status, 503);
    } finally { await new Promise(resolve => mock.close(resolve)); }
    // A failed database lookup must not be converted to an anonymous identity.
    const failureToken = randomBytes(32).toString('hex');
    const failureSignature = createHmac('sha256', secret).update(failureToken).digest('base64');
    const failureCookie = `better-auth.session_token=${encodeURIComponent(`${failureToken}.${failureSignature}`)}`;
    const closedRuntime = runtime;
    await closedRuntime.close();
    runtime = undefined;
    await assert.rejects(closedRuntime.resolveIdentity(failureCookie));
    const failedApi = createApp({ origin: publicOrigin, handler: closedRuntime.handler }).listen(0, '127.0.0.1');
    await once(failedApi, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${failedApi.address().port}/api/auth/get-session`, { headers: { cookie: failureCookie } });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: { code: 'AUTH_UNAVAILABLE', message: 'Sign-in is unavailable.' } });
    } finally { await new Promise(resolve => failedApi.close(resolve)); }
  } finally {
    await stop(web);
    await stop(serverProcess);
    if (api) await new Promise(resolve => api.close(resolve));
    if (runtime) await runtime.close();
    if (accountPool) await accountPool.end();
    if (started) await db.stop();
    await rm(temp, { recursive: true, force: true });
  }
});
