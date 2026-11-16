// Isolated feasibility test only. Never use this configuration in the application.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import express from 'express';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { toNodeHandler } from 'better-auth/node';

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('disposable PostgreSQL migration and Google authorization initiation', { timeout: 120000 }, async () => {
  // Never reads DATABASE_URL, GOOGLE credentials, or other external database settings.
  const scratchRoot = resolve(import.meta.dirname, '../../../.cache');
  await mkdir(scratchRoot, { recursive: true });
  const temp = await mkdtemp(join(scratchRoot, 'auth-pg-proof-'));
  const password = randomBytes(24).toString('hex');
  const port = await availablePort();
  const db = new EmbeddedPostgres({
    databaseDir: join(temp, 'db'), user: 'postgres', password, port,
    authMethod: 'scram-sha-256', persistent: false, autoRehydrateSymlinks: true,
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', `unix_socket_directories=${temp}`],
    onLog: () => {}, onError: () => {},
  });
  let started = false;
  let pool;
  let server;
  try {
    await db.initialise();
    await db.start();
    started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres', max: 2 });
    const app = express();
    // Register before JSON parsing as required by Better Auth's Express integration.
    let handler;
    app.all('/api/auth/*splat', (req, res) => handler(req, res));
    server = await new Promise((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    const options = {
      baseURL,
      secret: randomBytes(32).toString('hex'),
      database: pool,
      advanced: { disableOriginCheck: false, disableCSRFCheck: false },
      socialProviders: { google: { clientId: 'synthetic-client-id', clientSecret: 'synthetic-client-secret' } },
      emailAndPassword: { enabled: false },
    };
    const migrations = await getMigrations(options);
    assert.ok(migrations.toBeCreated.length > 0);
    await migrations.runMigrations();
    const again = await getMigrations(options);
    assert.equal(again.toBeCreated.length, 0);
    assert.equal(again.toBeAdded.length, 0);
    handler = toNodeHandler(betterAuth(options));

    const response = await fetch(`${baseURL}/api/auth/sign-in/social`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: baseURL },
      body: JSON.stringify({ provider: 'google', callbackURL: '/' }), redirect: 'manual',
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    const url = new URL(body.url);
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(url.searchParams.get('client_id'), 'synthetic-client-id');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.ok(url.searchParams.get('state'));
    assert.match(url.searchParams.get('redirect_uri'), /\/api\/auth\/callback\/google$/);
    assert.ok(response.headers.get('set-cookie'));
    const crossOrigin = await fetch(`${baseURL}/api/auth/sign-in/social`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://untrusted.example', cookie: 'example=1' },
      body: JSON.stringify({ provider: 'google', callbackURL: '/' }), redirect: 'manual',
    });
    assert.equal(crossOrigin.status, 403);
    // The same JSON request without a Cookie header was accepted in this
    // version. This is an observation, not proof of a browser exploit or safety.
    const noCookie = await fetch(`${baseURL}/api/auth/sign-in/social`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://untrusted.example' },
      body: JSON.stringify({ provider: 'google', callbackURL: '/' }), redirect: 'manual',
    });
    assert.equal(noCookie.status, 200);
    const badReturnURL = await fetch(`${baseURL}/api/auth/sign-in/social`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: baseURL },
      body: JSON.stringify({ provider: 'google', callbackURL: 'https://untrusted.example/' }),
    });
    assert.equal(badReturnURL.status, 403);
    const invalidCallback = await fetch(`${baseURL}/api/auth/callback/google?code=synthetic&state=invalid`, {
      redirect: 'manual',
    });
    assert.ok(invalidCallback.status >= 300 && invalidCallback.status < 400);
    // No request is sent to Google and no valid callback/token/session is simulated.
    const session = await fetch(`${baseURL}/api/auth/get-session`);
    assert.equal(session.status, 200);
    assert.equal(await session.json(), null);
    const invalid = await fetch(`${baseURL}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: baseURL },
      body: JSON.stringify({ email: 'test@example.invalid', password: 'synthetic' }),
    });
    assert.notEqual(invalid.status, 200);
  } finally {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (pool) await pool.end();
    if (started) await db.stop();
    await rm(temp, { recursive: true, force: true });
  }
});
