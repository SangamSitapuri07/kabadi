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
import { createCustomerDetailsStore, migrateCustomerDetails } from '../../apps/api/dist/customer-details.js';
import { migratePickups, createPickupStore } from '../../apps/api/dist/pickups.js';
import { migrateCatalog, createCatalogStore } from '../../apps/api/dist/catalog.js';
import { migrateCatalogRetries } from '../../apps/api/dist/catalog-retries.js';
import { randomUUID } from 'node:crypto';
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
    delete env.CUSTOMER_DETAILS_MIGRATION_CONFIRM;
    delete env.PICKUP_MIGRATION_CONFIRM;
    delete env.CATALOG_MIGRATION_CONFIRM;
    delete env.CATALOG_RETRY_MIGRATION_CONFIRM;
    accountPool = new pg.Pool({ connectionString: databaseURL, max: 2 });
    const accountMigration = (overrides = {}) => spawnSync(process.execPath, ['apps/api/dist/migrate-account-store.js'],
      { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 20000 });
    const detailsMigration = (overrides = {}) => spawnSync(process.execPath, ['apps/api/dist/migrate-customer-details.js'],
      { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 20000 });
    assert.equal(detailsMigration().status, 1);
    assert.equal(detailsMigration({ CUSTOMER_DETAILS_MIGRATION_CONFIRM: 'yes' }).status, 1);
    const catalogMigration = (overrides = {}) => spawnSync(process.execPath, ['apps/api/dist/migrate-catalog.js'], { cwd:root, env:{...env,...overrides}, encoding:'utf8', timeout:20000 });
    const retryMigration = (overrides = {}) => spawnSync(process.execPath, ['apps/api/dist/migrate-catalog-retries.js'], {cwd:root,env:{...env,...overrides},encoding:'utf8',timeout:20000});
    assert.equal(retryMigration().status,1);
    assert.equal(retryMigration({CATALOG_RETRY_MIGRATION_CONFIRM:'yes'}).status,1);
    assert.equal(catalogMigration().status, 1);
    assert.equal(catalogMigration({CATALOG_MIGRATION_CONFIRM:'yes'}).status, 1);
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
    assert.equal(detailsMigration({ CUSTOMER_DETAILS_MIGRATION_CONFIRM: 'yes' }).status, 1, 'authorization schema is required');
    assert.equal((await accountPool.query("SELECT to_regnamespace('kabadi_customer') AS schema")).rows[0].schema, null);
    // Refuse an unrelated preexisting schema rather than adopting or overwriting it.
    await accountPool.query('CREATE SCHEMA kabadi_authz');
    assert.equal(accountMigration({ AUTHORIZATION_MIGRATION_CONFIRM: 'yes' }).status, 1);
    await accountPool.query('DROP SCHEMA kabadi_authz');
    assert.equal(accountMigration({ AUTHORIZATION_MIGRATION_CONFIRM: 'yes' }).status, 0);
    // Re-running the explicit migration is a no-op for the recognized version.
    assert.equal(accountMigration({ AUTHORIZATION_MIGRATION_CONFIRM: 'yes' }).status, 0);
    assert.equal((await accountPool.query('SELECT count(*)::int AS count FROM kabadi_authz.accounts')).rows[0].count, 0);
    assert.equal((await accountPool.query('SELECT count(*)::int AS count FROM kabadi_authz.role_grants')).rows[0].count, 0);
    assert.equal(detailsMigration({ CUSTOMER_DETAILS_MIGRATION_CONFIRM: 'yes', NODE_ENV: 'production' }).status, 1);
    await accountPool.query('CREATE SCHEMA kabadi_customer');
    assert.equal(detailsMigration({ CUSTOMER_DETAILS_MIGRATION_CONFIRM: 'yes' }).status, 1);
    await accountPool.query('DROP SCHEMA kabadi_customer');
    assert.equal(detailsMigration({ CUSTOMER_DETAILS_MIGRATION_CONFIRM: 'yes' }).status, 0);
    assert.equal(detailsMigration({ CUSTOMER_DETAILS_MIGRATION_CONFIRM: 'yes' }).status, 0);
    assert.equal((await accountPool.query('SELECT count(*)::int AS count FROM kabadi_customer.details')).rows[0].count, 0);
    const pickupMigration = (overrides = {}) => spawnSync(process.execPath, ['apps/api/dist/migrate-pickups.js'], { cwd:root, env:{...env, ...overrides}, encoding:'utf8', timeout:20000 });
    assert.equal(pickupMigration().status, 1);
    assert.equal(pickupMigration({PICKUP_MIGRATION_CONFIRM:'yes', NODE_ENV:'production'}).status, 1);
    await accountPool.query('CREATE SCHEMA kabadi_pickup');
    assert.equal(pickupMigration({PICKUP_MIGRATION_CONFIRM:'yes'}).status, 1);
    await accountPool.query('DROP SCHEMA kabadi_pickup');
    assert.equal(pickupMigration({PICKUP_MIGRATION_CONFIRM:'yes'}).status, 0);
    assert.equal(pickupMigration({PICKUP_MIGRATION_CONFIRM:'yes'}).status, 0);
    assert.equal((await accountPool.query('SELECT count(*)::int AS count FROM kabadi_pickup.requests')).rows[0].count, 0);
    assert.equal(catalogMigration({CATALOG_MIGRATION_CONFIRM:'yes', NODE_ENV:'production'}).status, 1);
    await accountPool.query('CREATE SCHEMA kabadi_catalog');
    assert.equal(catalogMigration({CATALOG_MIGRATION_CONFIRM:'yes'}).status, 1);
    await accountPool.query('DROP SCHEMA kabadi_catalog');
    assert.equal(catalogMigration({CATALOG_MIGRATION_CONFIRM:'yes'}).status, 0);
    assert.equal(catalogMigration({CATALOG_MIGRATION_CONFIRM:'yes'}).status, 0);
    assert.equal((await accountPool.query('SELECT count(*)::int AS n FROM kabadi_catalog.categories')).rows[0].n, 0);
    assert.equal((await accountPool.query('SELECT count(*)::int AS n FROM kabadi_catalog.rates')).rows[0].n, 0);
    assert.equal(retryMigration({CATALOG_RETRY_MIGRATION_CONFIRM:'yes',NODE_ENV:'production'}).status,1);
    await accountPool.query('CREATE SCHEMA kabadi_catalog_retry');
    assert.equal(retryMigration({CATALOG_RETRY_MIGRATION_CONFIRM:'yes'}).status,1);
    await accountPool.query('DROP SCHEMA kabadi_catalog_retry');
    assert.equal(retryMigration({CATALOG_RETRY_MIGRATION_CONFIRM:'yes'}).status,0);
    assert.equal(retryMigration({CATALOG_RETRY_MIGRATION_CONFIRM:'yes'}).status,0);
    assert.equal((await accountPool.query('SELECT count(*)::int AS n FROM kabadi_catalog_retry.successes')).rows[0].n,0);

    // This setup directly grants synthetic admins in the disposable DB only.
    const admins = [randomUUID(), randomUUID()];
    for (const id of admins) {
      await accountPool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$2,$3,false,now(),now())',[id,'Synthetic',`${id}@example.test`]);
      await accountPool.query("INSERT INTO kabadi_authz.accounts VALUES ($1,'active')",[id]);
      await accountPool.query("INSERT INTO kabadi_authz.role_grants VALUES ($1,'admin')",[id]);
    }
    const rawCatalog = createCatalogStore(accountPool);
    const catalog = {...rawCatalog,
      createCategory:(actor,name,key=randomUUID())=>rawCatalog.createCategory(actor,name,key),
      addRate:(actor,category,at,rate,key=randomUUID())=>rawCatalog.addRate(actor,category,at,rate,key)};
    assert.equal(await catalog.listCategories('missing', null), 'forbidden');
    assert.equal(await catalog.listRates('missing', randomUUID(), null), 'forbidden');
    assert.equal(await catalog.createCategory('missing', 'Paper'), 'forbidden');
    const category = await catalog.createCategory(admins[0], 'Paper');
    assert.ok(category.id);
    assert.equal(await catalog.createCategory(admins[0], 'paper'), 'duplicate');
    const retryKey=randomUUID();
    const retryCategory=await catalog.createCategory(admins[0], 'Retry synthetic',retryKey);
    assert.deepEqual(await catalog.createCategory(admins[0], '  Retry synthetic  ',retryKey),retryCategory);
    assert.equal(await catalog.createCategory(admins[0], 'Different',retryKey),'conflict');
    assert.equal(await catalog.addRate(admins[0], retryCategory.id, '2099-01-01T00:00:00.000Z',123,retryKey),'conflict');
    const otherActorCategory=await catalog.createCategory(admins[1], 'Different actor same key',retryKey);
    assert.ok(otherActorCategory.id); assert.notEqual(otherActorCategory.id,retryCategory.id);
    await accountPool.query("ALTER TABLE kabadi_catalog_retry.successes ADD CONSTRAINT reject_test_retry CHECK (payload->>'name' <> 'Rollback synthetic')");
    const rollbackKey=randomUUID();
    try {
      await assert.rejects(catalog.createCategory(admins[0],'Rollback synthetic',rollbackKey));
      assert.equal((await accountPool.query("SELECT count(*)::int AS n FROM kabadi_catalog.categories WHERE name='Rollback synthetic'")).rows[0].n,0);
      assert.equal((await accountPool.query('SELECT count(*)::int AS n FROM kabadi_catalog_retry.successes WHERE request_key=$1',[rollbackKey])).rows[0].n,0);
    } finally { await accountPool.query('ALTER TABLE kabadi_catalog_retry.successes DROP CONSTRAINT reject_test_retry'); }
    const afterRollback=await catalog.createCategory(admins[0],'Rollback synthetic',rollbackKey);
    assert.ok(afterRollback.id);

    const raceKey=randomUUID();
    const retryRace=await Promise.all(Array.from({length:5},()=>catalog.createCategory(admins[0], 'Concurrent retry',raceKey)));
    assert.ok(retryRace.every(r=>r.id === retryRace[0].id));
    assert.equal((await accountPool.query("SELECT count(*)::int AS n FROM kabadi_catalog.categories WHERE name='Concurrent retry'")).rows[0].n,1);
    await accountPool.query('DELETE FROM kabadi_catalog_retry.successes WHERE request_key=ANY($1::uuid[])',[[retryKey,raceKey,rollbackKey]]);
    await accountPool.query('DELETE FROM kabadi_catalog.categories WHERE id=ANY($1::uuid[])',[[retryCategory.id,retryRace[0].id,otherActorCategory.id,afterRollback.id]]);

    await accountPool.query("UPDATE kabadi_authz.accounts SET status='suspended' WHERE user_id=$1",[admins[1]]);
    assert.equal(await catalog.createCategory(admins[1], 'Plastic'), 'forbidden');
    await accountPool.query("UPDATE kabadi_authz.accounts SET status='active' WHERE user_id=$1",[admins[1]]);
    await accountPool.query("DELETE FROM kabadi_authz.role_grants WHERE user_id=$1 AND role='admin'",[admins[1]]);
    assert.equal(await catalog.addRate(admins[1], category.id, '2099-01-01T00:00:00.000Z', 500), 'forbidden');
    await accountPool.query("INSERT INTO kabadi_authz.role_grants VALUES ($1,'admin')",[admins[1]]);
    assert.equal(await catalog.addRate(admins[0], category.id, '2000-01-01T00:00:00.000Z', 100), 'invalid-time');
    assert.equal(await catalog.addRate(admins[0], randomUUID(), '2099-01-01T00:00:00.000Z', 100), 'not-found');
    const race = await Promise.all(admins.map(id => catalog.addRate(id, category.id, '2099-01-01T00:00:00.000Z', 100)));
    assert.equal(race.filter(x => typeof x === 'object').length, 1);
    assert.equal(race.filter(x => x === 'invalid-time').length, 1);
    const rate1 = race.find(x => typeof x === 'object');
    assert.equal(await catalog.lookupAt(category.id, '2098-12-31T23:59:59.999Z'), null);
    assert.deepEqual(await catalog.lookupAt(category.id, '2099-01-01T00:00:00.000Z'), {rateId:rate1.id, paisePerKg:100});
    const rateKey = randomUUID();
    await accountPool.query("ALTER TABLE kabadi_catalog_retry.successes ADD CONSTRAINT reject_rate_retry CHECK (operation <> 'rate' OR payload->>'paisePerKg' <> '200')");
    try {
      await assert.rejects(catalog.addRate(admins[0], category.id, '2099-02-01T00:00:00.000Z', 200, rateKey));
      assert.equal((await accountPool.query('SELECT count(*)::int AS n FROM kabadi_catalog.rates WHERE category_id=$1',[category.id])).rows[0].n,1);
      assert.equal((await accountPool.query('SELECT count(*)::int AS n FROM kabadi_catalog_retry.successes WHERE request_key=$1',[rateKey])).rows[0].n,0);
    } finally { await accountPool.query('ALTER TABLE kabadi_catalog_retry.successes DROP CONSTRAINT reject_rate_retry'); }
    const rateAttempts=await Promise.all(Array.from({length:4},()=>catalog.addRate(admins[0], category.id, '2099-02-01T00:00:00.000Z', 200, rateKey)));
    const rate2=rateAttempts[0]; assert.ok(rateAttempts.every(r=>r.id === rate2.id));
    assert.deepEqual(await catalog.addRate(admins[0], category.id.toUpperCase(), '2099-02-01T00:00:00.000Z', 200, rateKey),rate2);
    assert.equal(await catalog.addRate(admins[0], category.id, '2099-02-01T00:00:00.000Z', 201, rateKey),'conflict');
    assert.equal(await catalog.addRate(admins[0], randomUUID(), '2099-02-01T00:00:00.000Z', 200, rateKey),'conflict');
    await accountPool.query("UPDATE kabadi_authz.accounts SET status='suspended' WHERE user_id=$1",[admins[0]]);
    assert.equal(await catalog.addRate(admins[0], category.id, '2099-02-01T00:00:00.000Z', 200, rateKey),'forbidden');
    await accountPool.query("UPDATE kabadi_authz.accounts SET status='active' WHERE user_id=$1",[admins[0]]);

    assert.deepEqual(await catalog.lookupAt(category.id, '2099-01-31T23:59:59.999Z'), {rateId:rate1.id, paisePerKg:100});
    assert.deepEqual(await catalog.lookupAt(category.id, '2099-02-01T00:00:00.000Z'), {rateId:rate2.id, paisePerKg:200});
    assert.equal(await catalog.addRate(admins[0], category.id, '2099-01-15T00:00:00.000Z', 150), 'invalid-time');
    assert.equal(await catalog.listRates(admins[0], randomUUID(), null), 'not-found');
    assert.deepEqual((await catalog.listRates(admins[0], category.id, null)).rates.map(r=>r.id).sort(), [rate1.id,rate2.id].sort());
    // Synthetic rows only: pagination returns every UUID exactly once across pages.
    const manyCategories=Array.from({length:55},()=>randomUUID());
    for (const id of manyCategories) await accountPool.query('INSERT INTO kabadi_catalog.categories (id,name,created_by) VALUES ($1,$2,$3)', [id,`synthetic-${id}`,admins[0]]);
    const manyRates=Array.from({length:55},()=>randomUUID());
    for (let i=0;i<manyRates.length;i++) await accountPool.query("INSERT INTO kabadi_catalog.rates (id,category_id,effective_from,paise_per_kg,created_by) VALUES ($1,$2,'2100-01-01T00:00:00Z'::timestamptz + ($3::int * interval '1 second'),1,$4)",[manyRates[i],category.id,i,admins[0]]);
    const firstCategories=await catalog.listCategories(admins[0],null);
    assert.equal(firstCategories.categories.length,50); assert.ok(firstCategories.nextAfter);
    const nextCategories=await catalog.listCategories(admins[0],firstCategories.nextAfter);
    assert.equal(nextCategories.nextAfter,null);
    assert.deepEqual([...firstCategories.categories,...nextCategories.categories].map(c=>c.id).sort(),[category.id,...manyCategories].sort());
    const firstRates=await catalog.listRates(admins[0],category.id,null);
    assert.equal(firstRates.rates.length,50); assert.ok(firstRates.nextAfter);
    const nextRates=await catalog.listRates(admins[0],category.id,firstRates.nextAfter);
    assert.equal(nextRates.nextAfter,null);
    assert.deepEqual([...firstRates.rates,...nextRates.rates].map(r=>r.id).sort(),[rate1.id,rate2.id,...manyRates].sort());
    await accountPool.query('DELETE FROM kabadi_catalog.rates WHERE id=ANY($1::uuid[])',[manyRates]);
    await accountPool.query('DELETE FROM kabadi_catalog.categories WHERE id=ANY($1::uuid[])',[manyCategories]);

    await accountPool.query('ALTER TABLE kabadi_catalog.rates ADD CONSTRAINT test_rate_failure CHECK (paise_per_kg <> 1111)');
    try {
      await assert.rejects(catalog.addRate(admins[0], category.id, '2099-03-01T00:00:00.000Z', 1111));
      assert.equal((await accountPool.query('SELECT count(*)::int AS n FROM kabadi_catalog.rates')).rows[0].n, 2);
    } finally { await accountPool.query('ALTER TABLE kabadi_catalog.rates DROP CONSTRAINT test_rate_failure'); }
    await migrateCatalog(accountPool);
    await migrateCatalogRetries(accountPool);
    assert.equal((await accountPool.query('SELECT count(*)::int AS n FROM kabadi_catalog.rates')).rows[0].n, 2);
    await assert.rejects(accountPool.query('DELETE FROM kabadi_authz.accounts WHERE user_id=$1',[admins[0]]), {code:'23001'});
    // Synthetic cleanup only; no application deletion operation is provided.
    await accountPool.query('DELETE FROM kabadi_catalog_retry.successes'); // synthetic cleanup only
    await accountPool.query('DELETE FROM kabadi_catalog.rates');
    await accountPool.query('DELETE FROM kabadi_catalog.categories');
    for (const id of admins) await accountPool.query('DELETE FROM "user" WHERE id=$1', [id]);
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
    assert.equal((await fetch(`http://127.0.0.1:${env.PORT}/api/v1/account/customer/details`)).status, 401, 'actual API process must wire details');
    assert.equal((await fetch(`http://127.0.0.1:${env.PORT}/api/v1/admin/catalog/categories`, {method:'POST', headers:{origin:publicOrigin,'content-type':'application/json','idempotency-key':randomUUID()}, body:JSON.stringify({name:'Synthetic'})})).status, 401, 'actual API process must wire catalog');
    assert.equal((await fetch(`http://127.0.0.1:${env.PORT}/api/v1/admin/catalog/categories`)).status, 401, 'actual API process must wire catalog reads');
    await stop(serverProcess);
    api = createApp({ origin: publicOrigin, handler: runtime.handler, resolveIdentity: runtime.resolveIdentity, onboardCustomer: runtime.onboardCustomer, customerDetails: runtime.customerDetails, pickups: runtime.pickups, catalog: runtime.catalog }).listen(0, '127.0.0.1');
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
      // Storage is not exposed by any HTTP route. Owner identity is supplied only
      // by the caller in this test; production route/session wiring is future work.
      const details = createCustomerDetailsStore(accountPool);
      const record = { name: ' Test person ', addressLine: '12 Example Road', city: 'Ludhiana', state: 'Punjab', postalCode: '141001' };
      assert.equal(await details.read(userId), null);
      assert.equal(await details.read('missing-user'), 'forbidden');
      assert.equal(await details.write(userId, record), 'saved');
      assert.deepEqual(await details.read(userId), { ...record, name: 'Test person' });
      assert.throws(() => details.write(userId, { ...record, userId: 'forged' }));
      const otherId = randomBytes(16).toString('hex');
      await client.query('INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, false, NOW(), NOW())', [otherId, 'Other', `${otherId}@example.test`]);
      await client.query("INSERT INTO kabadi_authz.accounts VALUES ($1, 'active')", [otherId]);
      await client.query("INSERT INTO kabadi_authz.role_grants VALUES ($1, 'customer')", [otherId]);
      assert.equal(await details.read(otherId), null, 'a different owner ID reads its own empty record');
      assert.equal(await details.write(otherId, { ...record, name: 'Other person' }), 'saved');
      assert.equal((await details.read(userId)).name, 'Test person');
      await client.query("ALTER TABLE kabadi_customer.details ADD CONSTRAINT test_write_failure CHECK (name <> 'Fail write')");
      try {
        await assert.rejects(details.write(userId, { ...record, name: 'Fail write' }));
        assert.equal((await details.read(userId)).name, 'Test person');
      } finally { await client.query('ALTER TABLE kabadi_customer.details DROP CONSTRAINT test_write_failure'); }
      await client.query("UPDATE kabadi_authz.accounts SET status = 'suspended' WHERE user_id = $1", [userId]);
      assert.equal(await details.read(userId), 'forbidden');
      assert.equal(await details.write(userId, record), 'forbidden');
      await client.query("UPDATE kabadi_authz.accounts SET status = 'active' WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM kabadi_authz.role_grants WHERE user_id = $1 AND role = 'customer'", [userId]);
      assert.equal(await details.read(userId), 'forbidden');
      assert.equal(await details.write(userId, record), 'forbidden');
      await client.query("INSERT INTO kabadi_authz.role_grants VALUES ($1, 'customer')", [userId]);
      await migrateCustomerDetails(accountPool);
      assert.equal((await details.read(userId)).name, 'Test person');
      await client.query('DELETE FROM kabadi_authz.accounts WHERE user_id = $1', [otherId]);
      assert.equal((await client.query('SELECT count(*)::int AS count FROM kabadi_customer.details WHERE user_id = $1', [otherId])).rows[0].count, 0);
      // Pickup persistence: owner isolation, retry deduplication and address snapshots.
      const pickups = createPickupStore(accountPool);
      const request = { requestKey:randomUUID(), material:'Paper', estimatedGrams:2500 };
      assert.equal(await pickups.create(otherId, request), 'forbidden');
      assert.deepEqual(await Promise.all([pickups.create(userId, request), pickups.create(userId, request)]), ['created', 'created']);
      assert.equal(await pickups.create(userId, {...request, material:'Plastic'}), 'conflict');
      assert.equal((await pickups.list(userId)).length, 1);
      await details.write(userId, {...record, addressLine:'New test road'});
      assert.equal((await pickups.list(userId))[0].address.addressLine, '12 Example Road');
      await details.write(userId, record);
      await migratePickups(accountPool);
      assert.equal((await pickups.list(userId)).length, 1);
      await client.query("UPDATE kabadi_authz.accounts SET status='suspended' WHERE user_id=$1", [userId]);
      assert.equal(await pickups.list(userId), 'forbidden');
      assert.equal(await pickups.create(userId, {...request, requestKey:randomUUID()}), 'forbidden');
      await client.query("UPDATE kabadi_authz.accounts SET status='active' WHERE user_id=$1", [userId]);
      await client.query("DELETE FROM kabadi_authz.role_grants WHERE user_id=$1 AND role='customer'", [userId]);
      assert.equal(await pickups.list(userId), 'forbidden');
      assert.equal(await pickups.create(userId, {...request, requestKey:randomUUID()}), 'forbidden');
      await client.query("INSERT INTO kabadi_authz.role_grants VALUES ($1, 'customer')", [userId]);
      await client.query("ALTER TABLE kabadi_pickup.requests ADD CONSTRAINT test_failure CHECK (material <> 'Fail insert')");
      try {
        await assert.rejects(pickups.create(userId, {...request, requestKey:randomUUID(), material:'Fail insert'}));
        assert.equal((await pickups.list(userId)).length, 1);
      } finally { await client.query('ALTER TABLE kabadi_pickup.requests DROP CONSTRAINT test_failure'); }
      const pickupPath = '/api/v1/customer/pickups';
      for (const base of [apiOrigin, publicOrigin]) {
        const send = (body, origin=publicOrigin, extra={}) => fetch(base+pickupPath, {method:'POST', headers:{origin, 'content-type':'application/json', ...extra}, body:JSON.stringify(body)});
        assert.equal((await fetch(base+pickupPath)).status, 401);
        assert.equal((await send(request, publicOrigin, {cookie:cookie+'x'})).status, 401);
        assert.equal((await send(request, 'https://evil.example', {cookie})).status, 403);
        assert.equal((await send({...request, userId:otherId}, publicOrigin, {cookie})).status, 400);
        assert.equal((await send(request, publicOrigin, {cookie,'x-user-id':otherId})).status, 200);
        const listed = await fetch(base+pickupPath, {headers:{cookie,'x-user-id':otherId}});
        assert.equal(listed.status, 200); assert.equal(listed.headers.get('cache-control'), 'no-store');
        const contents = await listed.json(); assert.equal(contents.data.pickups.length, 1); assert.equal(contents.data.pickups[0].address.addressLine, '12 Example Road');
      }
      // Real API and Next bridge with a signed synthetic session and disposable DB.
      const detailsPath = '/api/v1/account/customer/details';
      const readDetails = (base, headers = {}) => fetch(base + detailsPath, { headers });
      const writeDetails = (base, data, requestOrigin = publicOrigin, headers = {}) => fetch(base + detailsPath, {
        method: 'PUT', headers: { origin: requestOrigin, 'content-type': 'application/json', ...headers }, body: typeof data === 'string' ? data : JSON.stringify(data),
      });
      for (const base of [apiOrigin, publicOrigin]) {
        assert.equal((await readDetails(base)).status, 401);
        assert.equal((await writeDetails(base, record)).status, 401);
        assert.equal((await writeDetails(base, record, 'https://evil.example', { cookie })).status, 403);
        assert.equal((await writeDetails(base, { ...record, userId: otherId }, publicOrigin, { cookie })).status, 400);
        assert.equal((await writeDetails(base, 'x'.repeat(4097), publicOrigin, { cookie })).status, 413);
        const initial = await readDetails(base, { cookie, 'x-user-id': otherId });
        assert.equal(initial.status, 200);
        assert.equal(initial.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await initial.json(), { data: { details: { ...record, name: 'Test person' } } });
        const saved = await writeDetails(base, { ...record, name: 'Updated Person' }, publicOrigin, { cookie, 'x-user-id': otherId });
        assert.equal(saved.status, 200);
        assert.deepEqual(await saved.json(), { data: { saved: true } });
        assert.equal((await details.read(userId)).name, 'Updated Person');
        await details.write(userId, record);
      }
      await client.query('ALTER SCHEMA kabadi_customer RENAME TO kabadi_customer_unavailable');
      try {
        assert.equal((await readDetails(publicOrigin, { cookie })).status, 503);
        assert.equal((await writeDetails(publicOrigin, record, publicOrigin, { cookie })).status, 503);
      } finally { await client.query('ALTER SCHEMA kabadi_customer_unavailable RENAME TO kabadi_customer'); }
      // A second real session is confined to its own account, despite forged headers.
      await client.query("INSERT INTO kabadi_authz.accounts VALUES ($1, 'active')", [otherId]);
      await client.query("INSERT INTO kabadi_authz.role_grants VALUES ($1, 'customer')", [otherId]);
      const otherToken = randomBytes(32).toString('hex');
      await client.query('INSERT INTO "session" (id, "userId", token, "expiresAt", "createdAt", "updatedAt") VALUES ($1, $2, $3, NOW() + INTERVAL \'1 hour\', NOW(), NOW())', [randomBytes(16).toString('hex'), otherId, otherToken]);
      const otherSignature = createHmac('sha256', secret).update(otherToken).digest('base64');
      const otherCookie = `better-auth.session_token=${encodeURIComponent(`${otherToken}.${otherSignature}`)}`;
      assert.deepEqual(await (await readDetails(publicOrigin, { cookie: otherCookie, 'x-user-id': userId })).json(), { data: { details: null } });
      const otherList = await (await fetch(publicOrigin + '/api/v1/customer/pickups', {headers:{cookie:otherCookie, 'x-user-id':userId}})).json();
      assert.deepEqual(otherList.data.pickups, []);
      const noProfile = await fetch(publicOrigin + '/api/v1/customer/pickups', {method:'POST',headers:{origin:publicOrigin, 'content-type':'application/json', cookie:otherCookie},body:JSON.stringify({...request, requestKey:randomUUID()})});
      assert.equal(noProfile.status, 409);
      assert.equal((await noProfile.json()).error.code, 'PROFILE_REQUIRED');
      await client.query("UPDATE kabadi_authz.accounts SET status = 'suspended' WHERE user_id = $1", [userId]);
      assert.equal((await readDetails(publicOrigin, { cookie })).status, 403);
      assert.equal((await writeDetails(publicOrigin, record, publicOrigin, { cookie })).status, 403);
      await client.query("UPDATE kabadi_authz.accounts SET status = 'active' WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM kabadi_authz.role_grants WHERE user_id = $1 AND role = 'customer'", [userId]);
      assert.equal((await readDetails(publicOrigin, { cookie })).status, 403);
      assert.equal((await writeDetails(publicOrigin, record, publicOrigin, { cookie })).status, 403);
      await client.query("INSERT INTO kabadi_authz.role_grants VALUES ($1, 'customer')", [userId]);
      // Direct API catalog mutations use a synthetic session and actual PostgreSQL
      // grant checks; no role is taken from headers or the request body.
      const catalogPath = '/api/v1/admin/catalog/categories';
      const catalogPost = (path, body, selectedCookie = cookie, origin = publicOrigin, key = randomUUID()) => fetch(apiOrigin + path, {
        method:'POST', headers:{origin, cookie:selectedCookie, 'content-type':'application/json', 'x-role':'admin','idempotency-key':key}, body:JSON.stringify(body)
      });
      assert.equal((await catalogPost(catalogPath, {name:'Synthetic HTTP'}, '')).status, 401);
      assert.equal((await catalogPost(catalogPath, {name:'Synthetic HTTP'})).status, 403);
      const catalogGet = (path, selectedCookie = cookie) => fetch(apiOrigin+path,{headers:{cookie:selectedCookie,'x-role':'admin'}});
      assert.equal((await catalogGet(catalogPath,'')).status,401);
      assert.equal((await catalogGet(catalogPath)).status,403);

      assert.equal((await catalogPost(catalogPath, {name:'Synthetic HTTP'}, cookie, 'https://evil.example')).status, 403);
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
        const httpKey=randomUUID();
        const catResponse = await catalogPost(catalogPath, {name:'Synthetic HTTP'},cookie,publicOrigin,httpKey);
        assert.equal(catResponse.status,201);
        const catId = (await catResponse.json()).data.id;
        const replay = await catalogPost(catalogPath,{name:'Synthetic HTTP'},cookie,publicOrigin,httpKey);
        assert.equal(replay.status,201); assert.deepEqual(await replay.json(),{data:{id:catId}});
        assert.equal((await catalogPost(catalogPath,{name:'Different'},cookie,publicOrigin,httpKey)).status,409);
        assert.equal((await catalogPost(catalogPath, {name:'Synthetic HTTP'})).status,409);
        const httpRateKey=randomUUID(), httpRate={effectiveFrom:'2099-01-01T00:00:00.000Z',paisePerKg:123};
        const rateResponse = await catalogPost(`${catalogPath}/${catId}/rates`, httpRate,cookie,publicOrigin,httpRateKey);
        assert.equal(rateResponse.status,201);
        const rateId=(await rateResponse.json()).data.id;
        const replayRate=await catalogPost(`${catalogPath}/${catId}/rates`,httpRate,cookie,publicOrigin,httpRateKey);
        assert.equal(replayRate.status,201); assert.deepEqual(await replayRate.json(),{data:{id:rateId}});
        assert.equal((await catalogPost(`${catalogPath}/${catId}/rates`,{...httpRate,paisePerKg:124},cookie,publicOrigin,httpRateKey)).status,409);
        assert.deepEqual(await catalog.lookupAt(catId, '2099-01-01T00:00:00.000Z'), {rateId,paisePerKg:123});
        let catalogRead=await catalogGet(catalogPath); assert.equal(catalogRead.status,200); assert.equal(catalogRead.headers.get('cache-control'),'no-store');
        assert.deepEqual(await catalogRead.json(),{data:{categories:[{id:catId,name:'Synthetic HTTP',active:true}],nextAfter:null}});
        catalogRead=await catalogGet(`${catalogPath}/${catId}/rates`); assert.equal(catalogRead.status,200);
        assert.deepEqual(await catalogRead.json(),{data:{rates:[{id:rateId,effectiveFrom:'2099-01-01T00:00:00.000Z',paisePerKg:123}],nextAfter:null}});
        assert.equal((await catalogGet(`${catalogPath}/${randomUUID()}/rates`)).status,404);

        await client.query("UPDATE kabadi_authz.accounts SET status='suspended' WHERE user_id=$1",[userId]);
        assert.equal((await catalogPost(catalogPath, {name:'Denied'})).status,403);
        assert.equal((await catalogPost(catalogPath,{name:'Synthetic HTTP'},cookie,publicOrigin,httpKey)).status,403);
        assert.equal((await catalogGet(catalogPath)).status,403);
        await client.query("UPDATE kabadi_authz.accounts SET status='active' WHERE user_id=$1",[userId]);
        await client.query("DELETE FROM kabadi_authz.role_grants WHERE user_id=$1 AND role='admin'",[userId]);
        assert.equal((await catalogPost(`${catalogPath}/${catId}/rates`, {effectiveFrom:'2099-02-01T00:00:00.000Z',paisePerKg:456})).status,403);
        assert.equal((await catalogGet(`${catalogPath}/${catId}/rates`)).status,403);
        await client.query("INSERT INTO kabadi_authz.role_grants VALUES ($1,'admin')",[userId]);
        await client.query('ALTER SCHEMA kabadi_catalog_retry RENAME TO kabadi_catalog_retry_unavailable');
        try {
          assert.equal((await catalogPost(catalogPath,{name:'Unavailable retry'},cookie,publicOrigin,randomUUID())).status,503);
          assert.equal((await catalogGet(catalogPath)).status,200); // reads do not rely on retry schema
        } finally { await client.query('ALTER SCHEMA kabadi_catalog_retry_unavailable RENAME TO kabadi_catalog_retry'); }
        await client.query('DELETE FROM kabadi_catalog_retry.successes WHERE actor_id=$1',[userId]); // synthetic cleanup only
        await client.query('DELETE FROM kabadi_catalog.rates WHERE category_id=$1',[catId]);
        await client.query('DELETE FROM kabadi_catalog.categories WHERE id=$1',[catId]); // disposable test cleanup only
        await client.query('ALTER SCHEMA kabadi_catalog RENAME TO kabadi_catalog_unavailable');
        try {
          const unavailableCatalog = await catalogPost(catalogPath, {name:'Unavailable'});
          assert.equal((await catalogGet(catalogPath)).status,503);
          assert.equal(unavailableCatalog.status,503);
          assert.deepEqual(await unavailableCatalog.json(), {error:{code:'CATALOG_UNAVAILABLE',message:'Catalog administration is unavailable.'}});
        } finally { await client.query('ALTER SCHEMA kabadi_catalog_unavailable RENAME TO kabadi_catalog'); }

        // A missing schema must become a sanitized failure, never a grant.
        await client.query('ALTER SCHEMA kabadi_authz RENAME TO kabadi_authz_unavailable');
        try {
          const unavailableAccount = await fetch(url, { headers: { cookie } });
          assert.equal(unavailableAccount.status, 503);
          assert.deepEqual(await unavailableAccount.json(), { error: { code: 'AUTHORIZATION_UNAVAILABLE', message: 'Access is unavailable.' } });
        } finally { await client.query('ALTER SCHEMA kabadi_authz_unavailable RENAME TO kabadi_authz'); }
        await assert.rejects(client.query('DELETE FROM kabadi_authz.accounts WHERE user_id = $1', [userId]), {code:'23001'});
        await client.query('DELETE FROM kabadi_pickup.requests WHERE user_id = $1', [userId]); // synthetic test cleanup only
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
      assert.equal((await readDetails(publicOrigin, { cookie })).status, 401);
      assert.equal((await writeDetails(publicOrigin, record, publicOrigin, { cookie })).status, 401);
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
        mode === 'customer' ? { data: { customer: 'ready', userId: 'private' }, token: 'synthetic-secret' } :
        mode === 'details' ? { data: { details: { name: 'Mock', addressLine: 'Example', city: 'Test', state: 'Test', postalCode: '123', userId: 'private' } }, token: 'synthetic-secret' } : { authenticated: 'yes' };
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
      mode = 'details';
      const projectedDetails = await fetch(publicOrigin + '/api/v1/account/customer/details');
      assert.deepEqual(await projectedDetails.json(), { data: { details: { name: 'Mock', addressLine: 'Example', city: 'Test', state: 'Test', postalCode: '123' } } });
      assert.ok(projectedDetails.headers.getSetCookie().some(value => value.includes('synthetic=refresh')));
      mode = 'invalid';
      assert.equal((await fetch(publicOrigin + '/api/v1/account/customer/details')).status, 503);
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
