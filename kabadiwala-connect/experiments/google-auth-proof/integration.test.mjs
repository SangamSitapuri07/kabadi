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
  let started = false, runtime, api, web, serverProcess;
  try {
    await db.initialise(); await db.start(); started = true;
    const databaseURL = `postgres://postgres:${password}@127.0.0.1:${dbPort}/postgres`;
    const secret = randomBytes(32).toString('hex');
    const env = { ...process.env, NODE_ENV: 'development', AUTH_ENABLED: 'true', AUTH_PUBLIC_ORIGIN: publicOrigin,
      DATABASE_URL: databaseURL, BETTER_AUTH_SECRET: secret, GOOGLE_CLIENT_ID: 'fake-google-client', GOOGLE_CLIENT_SECRET: 'fake-google-secret', PORT: String(await port()) };
    delete env.AUTH_MIGRATION_CONFIRM;
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
    await stop(serverProcess);
    api = createApp({ origin: publicOrigin, handler: runtime.handler }).listen(0, '127.0.0.1');
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
    assert.equal(new URL(badCallback.headers.get('location')).origin, publicOrigin);
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
      res.end(JSON.stringify(mode === 'valid' ? { authenticated: true, token: 'synthetic-secret', user: { name: 'private' } } : { authenticated: 'yes' }));
    });
    mock.listen(Number(new URL(apiOrigin).port), '127.0.0.1');
    await once(mock, 'listening');
    try {
      const projected = await fetch(publicOrigin + '/api/auth/get-session');
      assert.deepEqual(await projected.json(), { authenticated: true });
      assert.ok(projected.headers.getSetCookie().some(value => value.includes('synthetic=refresh')));
      mode = 'invalid';
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
    if (started) await db.stop();
    await rm(temp, { recursive: true, force: true });
  }
});
