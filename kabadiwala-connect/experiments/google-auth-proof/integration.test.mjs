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
import { createRoleAdmin, migrateRoleAdmin } from '../../apps/api/dist/role-admin.js';
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
    delete env.ROLE_ADMIN_MIGRATION_CONFIRM;
    delete env.DEV_ROLE_TOOL_CONFIRM;
    accountPool = new pg.Pool({ connectionString: databaseURL, max: 2 });
    const accountMigration = (overrides = {}) => spawnSync(process.execPath, ['apps/api/dist/migrate-account-store.js'],
      { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 20000 });
    const detailsMigration = (overrides = {}) => spawnSync(process.execPath, ['apps/api/dist/migrate-customer-details.js'],
      { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 20000 });
    assert.equal(detailsMigration().status, 1);
    assert.equal(detailsMigration({ CUSTOMER_DETAILS_MIGRATION_CONFIRM: 'yes' }).status, 1);
    const catalogMigration = (overrides = {}) => spawnSync(process.execPath, ['apps/api/dist/migrate-catalog.js'], { cwd:root, env:{...env,...overrides}, encoding:'utf8', timeout:20000 });
    const retryMigration = (overrides = {}) => spawnSync(process.execPath, ['apps/api/dist/migrate-catalog-retries.js'], {cwd:root,env:{...env,...overrides},encoding:'utf8',timeout:20000});
    const roleAdminMigration = (overrides = {}) => spawnSync(process.execPath, ['apps/api/dist/migrate-role-admin.js'], {cwd:root,env:{...env,...overrides},encoding:'utf8',timeout:20000});
    const roleTool = (args, overrides = {}) => spawnSync(process.execPath, ['apps/api/dist/role-admin-cli.js', ...args], {cwd:root,env:{...env,...overrides},encoding:'utf8',timeout:20000});
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
    assert.equal(catalogMigration({CATALOG_MIGRATION_CONFIRM:'yes', NODE_ENV:'production'}).status, 1);
    await accountPool.query('CREATE SCHEMA kabadi_catalog');
    assert.equal(catalogMigration({CATALOG_MIGRATION_CONFIRM:'yes'}).status, 1);
    await accountPool.query('DROP SCHEMA kabadi_catalog');
    assert.equal(catalogMigration({CATALOG_MIGRATION_CONFIRM:'yes'}).status, 0);
    assert.equal(catalogMigration({CATALOG_MIGRATION_CONFIRM:'yes'}).status, 0);
    // Pickups depend on the catalog schema, so this must run after it.
    const pickupMigration = (overrides = {}) => spawnSync(process.execPath, ['apps/api/dist/migrate-pickups.js'], { cwd:root, env:{...env, ...overrides}, encoding:'utf8', timeout:20000 });
    assert.equal(pickupMigration().status, 1);
    assert.equal(pickupMigration({PICKUP_MIGRATION_CONFIRM:'yes', NODE_ENV:'production'}).status, 1);
    // Without the catalog schema the migration refuses rather than half-applying.
    await accountPool.query('ALTER SCHEMA kabadi_catalog RENAME TO kabadi_catalog_hold');
    try {
      assert.equal(pickupMigration({PICKUP_MIGRATION_CONFIRM:'yes'}).status, 1);
      assert.equal((await accountPool.query("SELECT to_regclass('kabadi_pickup.requests')::text AS t")).rows[0].t, null);
    } finally { await accountPool.query('ALTER SCHEMA kabadi_catalog_hold RENAME TO kabadi_catalog'); }
    await accountPool.query('CREATE SCHEMA kabadi_pickup');
    assert.equal(pickupMigration({PICKUP_MIGRATION_CONFIRM:'yes'}).status, 1);
    await accountPool.query('DROP SCHEMA kabadi_pickup');
    // A migration run without configuration must name the cause, not blame the
    // schema, and must never echo connection details.
    {
      const bare = spawnSync(process.execPath, ['apps/api/dist/migrate-pickups.js'], {
        cwd:root, encoding:'utf8', timeout:20000,
        env:{PATH:process.env.PATH, PICKUP_MIGRATION_CONFIRM:'yes'},
      });
      assert.equal(bare.status, 1);
      assert.match(bare.stderr, /No configuration was loaded/);
      assert.match(bare.stderr, /kabadiwala-connect directory/);
      assert.match(bare.stderr, /No changes were committed/);
      assert.ok(!bare.stderr.includes(databaseURL), 'the error must not leak the database URL');
    }
    const freshPickup = pickupMigration({PICKUP_MIGRATION_CONFIRM:'yes'});
    assert.equal(freshPickup.status, 0);
    assert.match(freshPickup.stdout, /created at version 2/i, 'a fresh schema says so');
    const rerunPickup = pickupMigration({PICKUP_MIGRATION_CONFIRM:'yes'});
    assert.equal(rerunPickup.status, 0);
    assert.match(rerunPickup.stdout, /already version 2; nothing changed/i, 'a re-run must not claim it did work');
    assert.equal((await accountPool.query('SELECT count(*)::int AS count FROM kabadi_pickup.requests')).rows[0].count, 0);
    assert.equal((await accountPool.query('SELECT version::int AS v FROM kabadi_pickup.schema_version')).rows[0].v, 2);
    assert.equal((await accountPool.query('SELECT count(*)::int AS n FROM kabadi_catalog.categories')).rows[0].n, 0);
    assert.equal((await accountPool.query('SELECT count(*)::int AS n FROM kabadi_catalog.rates')).rows[0].n, 0);
    assert.equal(retryMigration({CATALOG_RETRY_MIGRATION_CONFIRM:'yes',NODE_ENV:'production'}).status,1);
    await accountPool.query('CREATE SCHEMA kabadi_catalog_retry');
    assert.equal(retryMigration({CATALOG_RETRY_MIGRATION_CONFIRM:'yes'}).status,1);
    await accountPool.query('DROP SCHEMA kabadi_catalog_retry');
    assert.equal(retryMigration({CATALOG_RETRY_MIGRATION_CONFIRM:'yes'}).status,0);
    assert.equal(retryMigration({CATALOG_RETRY_MIGRATION_CONFIRM:'yes'}).status,0);
    assert.equal((await accountPool.query('SELECT count(*)::int AS n FROM kabadi_catalog_retry.successes')).rows[0].n,0);
    assert.equal(roleAdminMigration().status,1);
    assert.equal(roleAdminMigration({ROLE_ADMIN_MIGRATION_CONFIRM:'yes',NODE_ENV:'production'}).status,1);
    assert.equal(roleAdminMigration({ROLE_ADMIN_MIGRATION_CONFIRM:'yes'}).status,0);
    assert.equal(roleAdminMigration({ROLE_ADMIN_MIGRATION_CONFIRM:'yes'}).status,0);
    assert.equal((await accountPool.query('SELECT count(*)::int AS n FROM kabadi_admin.role_changes')).rows[0].n,0);

    // A v1 pickup row (free text, no category) must survive the v2 upgrade
    // unchanged and must never gain an invented estimate.
    {
      const legacyUser = randomUUID();
      const legacyId = randomUUID();
      await accountPool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$2,$3,false,now(),now())',[legacyUser,'Legacy',`${legacyUser}@example.test`]);
      await accountPool.query("INSERT INTO kabadi_authz.accounts VALUES ($1,'active')",[legacyUser]);
      await accountPool.query("INSERT INTO kabadi_authz.role_grants VALUES ($1,'customer')",[legacyUser]);
      // Rebuild the pickup schema at v1 exactly as the first release created it.
      await accountPool.query('DELETE FROM kabadi_pickup.requests');
      await accountPool.query('DROP TABLE kabadi_pickup.requests');
      await accountPool.query('DROP TABLE kabadi_pickup.schema_version');
      await accountPool.query(`CREATE TABLE kabadi_pickup.requests (
        id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES kabadi_authz.accounts(user_id) ON DELETE RESTRICT,
        request_key uuid NOT NULL, material text NOT NULL CHECK (char_length(material) BETWEEN 1 AND 100),
        estimated_grams integer NOT NULL CHECK (estimated_grams BETWEEN 1 AND 10000000),
        status text NOT NULL DEFAULT 'requested' CHECK (status = 'requested'),
        name text NOT NULL, address_line text NOT NULL, city text NOT NULL, state text NOT NULL, postal_code text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, request_key))`);
      await accountPool.query('CREATE INDEX ON kabadi_pickup.requests (user_id, created_at DESC, id DESC)');
      await accountPool.query('CREATE TABLE kabadi_pickup.schema_version (version integer PRIMARY KEY CHECK (version = 1))');
      await accountPool.query('INSERT INTO kabadi_pickup.schema_version VALUES (1)');
      const legacyKey = randomUUID();
      await accountPool.query(`INSERT INTO kabadi_pickup.requests
        (id,user_id,request_key,material,estimated_grams,name,address_line,city,state,postal_code)
        VALUES ($1,$2,$3,'Old newspapers',1200,'Legacy','12 Example Road','Ludhiana','Punjab','141001')`,[legacyId,legacyUser,legacyKey]);
      const upgradedRun = pickupMigration({PICKUP_MIGRATION_CONFIRM:'yes'});
      assert.equal(upgradedRun.status, 0);
      assert.match(upgradedRun.stdout, /upgraded from version 1 to version 2/i);
      assert.match(upgradedRun.stdout, /1 pre-pricing request\(s\) keep their free-text material and have no estimate/i,
        'the operator must be told legacy rows survive without a price');
      assert.equal((await accountPool.query('SELECT version::int AS v FROM kabadi_pickup.schema_version')).rows[0].v, 2);
      const upgraded = (await accountPool.query('SELECT material,category_id,amount_paise,estimated_grams FROM kabadi_pickup.requests WHERE id=$1',[legacyId])).rows[0];
      assert.deepEqual(upgraded, {material:'Old newspapers', category_id:null, amount_paise:null, estimated_grams:1200});
      // The upgraded schema still refuses a half-priced row.
      await assert.rejects(accountPool.query(`INSERT INTO kabadi_pickup.requests (id,user_id,request_key,estimated_grams,name,address_line,city,state,postal_code,paise_per_kg)
        VALUES ($1,$2,$3,10,'X','y','z','w','1',500)`,[randomUUID(),legacyUser,randomUUID()]), {code:'23514'});
      // And a legacy row can be listed through the store, labelled as legacy.
      const legacyList = await createPickupStore(accountPool).list(legacyUser);
      assert.equal(legacyList.length, 1);
      assert.equal(legacyList[0].material, 'Old newspapers');
      assert.equal(legacyList[0].amountPaise, null);
      assert.equal(legacyList[0].categoryId, null);
      await accountPool.query('DELETE FROM kabadi_pickup.requests WHERE user_id=$1',[legacyUser]);
      await accountPool.query('DELETE FROM kabadi_authz.accounts WHERE user_id=$1',[legacyUser]);
      await accountPool.query('DELETE FROM "user" WHERE id=$1',[legacyUser]);
    }
    assert.equal(roleTool(['list']).status,1,'role tool must require explicit confirmation');
    assert.equal(roleTool(['list'],{DEV_ROLE_TOOL_CONFIRM:'yes',NODE_ENV:'production'}).status,1,'role tool must refuse production');
    assert.match(roleTool(['list'],{DEV_ROLE_TOOL_CONFIRM:'yes'}).stdout,/Active administrators: 0/);

    // The local operator tool must be the only supported way to create an
    // admin grant. It resolves a user by exact email, refuses unknown or
    // suspended accounts, records an audit row, and never runs in production.
    const tool = createRoleAdmin(accountPool);
    const operatorUser = randomUUID(), operatorEmail = `operator-${operatorUser}@example.test`;
    await accountPool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$2,$3,false,now(),now())',[operatorUser,'Operator',operatorEmail]);
    assert.deepEqual(await tool.grant(operatorEmail,'admin','only the audit schema exists so far'),{outcome:'no-account'});
    await accountPool.query("INSERT INTO kabadi_authz.accounts VALUES ($1,'active')",[operatorUser]);
    await assert.rejects(tool.grant(operatorEmail,'admin','too short'));
    await assert.rejects(tool.grant(operatorEmail,'root','a long enough but invalid role'));
    await assert.rejects(tool.grant('not-an-email','admin','a long enough but invalid email'));
    assert.deepEqual(await tool.grant(`nobody-${operatorUser}@example.test`,'admin','must resolve a real user'),{outcome:'unknown-user'});
    const granted = await tool.grant(` ${operatorEmail.toUpperCase()} `,'admin','bootstrap first local administrator');
    assert.equal(granted.outcome,'changed'); assert.equal(granted.role,'admin');
    assert.deepEqual(await tool.grant(operatorEmail,'admin','repeating a grant is a no-op'),{outcome:'already-granted',userId:operatorUser,role:'admin'});
    assert.equal(await tool.activeAdminCount(),1);
    // Operator listing: masked addresses, account/role state, no IDs.
    const listing = await tool.listUsers(50);
    assert.ok(listing.total >= 1);
    const operatorRow = listing.users.find(u => u.status === 'active' && u.roles.includes('admin'));
    assert.equal(listing.users.filter(u => u.email === operatorEmail).length, 0, 'listing must be masked');
    assert.ok(operatorRow, 'operator must appear in the listing');
    assert.equal(operatorRow.status,'active');
    assert.deepEqual(operatorRow.roles,['admin']);
    assert.ok(!JSON.stringify(listing).includes(operatorUser), 'listing must not expose user IDs');
    assert.deepEqual((await tool.listUsers(1)).users.length,1, 'limit is respected');
    let changes = await tool.recentChanges(5);
    assert.equal(changes.length,1); assert.equal(changes[0].action,'grant'); assert.equal(changes[0].role,'admin');
    assert.equal(changes[0].email,operatorEmail);
    await accountPool.query("UPDATE kabadi_authz.accounts SET status='suspended' WHERE user_id=$1",[operatorUser]);
    assert.equal(await tool.activeAdminCount(),0,'a suspended admin must not count');
    assert.deepEqual(await tool.revoke(operatorEmail,'admin','cleanup of the synthetic bootstrap'),{outcome:'suspended-account'});
    await accountPool.query("UPDATE kabadi_authz.accounts SET status='active' WHERE user_id=$1",[operatorUser]);
    assert.equal((await tool.revoke(operatorEmail,'admin','remove the synthetic bootstrap')).outcome,'changed');
    assert.equal(await tool.activeAdminCount(),0);
    assert.deepEqual(await tool.revoke(operatorEmail,'admin','repeating a revoke is a no-op'),{outcome:'already-absent',userId:operatorUser,role:'admin'});
    changes = await tool.recentChanges(5);
    assert.deepEqual(changes.map(c=>c.action),['revoke','grant']);
    await accountPool.query('DELETE FROM kabadi_admin.role_changes WHERE user_id=$1',[operatorUser]);
    await accountPool.query('DELETE FROM "user" WHERE id=$1',[operatorUser]);
    assert.equal((await accountPool.query('SELECT count(*)::int AS n FROM kabadi_admin.role_changes')).rows[0].n,0);

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
    // `next start` serves whatever is in apps/web/.next, so the bridge under
    // test must be rebuilt first or this would silently exercise stale code.
    const webBuild = spawnSync(process.execPath, ['node_modules/next/dist/bin/next','build','apps/web'], { cwd:root, env:{...process.env, NEXT_TELEMETRY_DISABLED:'1'}, encoding:'utf8', timeout:300000 });
    assert.equal(webBuild.status, 0, `web build failed: ${webBuild.stderr?.slice(-800)}`);
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
      // Pickup persistence: owner isolation, retry deduplication, address and
      // price snapshots, and request-time rate selection (schema v2).
      const pickups = createPickupStore(accountPool);
      // The earlier catalog tests removed their synthetic admins, so create a
      // fresh one here; the write path itself still enforces the admin role.
      const pickupAdmin = randomUUID();
      await accountPool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$2,$3,false,now(),now())',[pickupAdmin,'Synthetic admin',`${pickupAdmin}@example.test`]);
      await accountPool.query("INSERT INTO kabadi_authz.accounts VALUES ($1,'active')",[pickupAdmin]);
      await accountPool.query("INSERT INTO kabadi_authz.role_grants VALUES ($1,'admin')",[pickupAdmin]);
      const pricedCategory = await catalog.createCategory(pickupAdmin, 'Pickup priced synthetic');
      assert.equal(typeof pricedCategory.id, 'string', 'the synthetic admin must be able to create a category');
      const nowMs = Date.now();
      // Rates may only be created with a future start, so a "live" rate is
      // simulated by back-dating the row in the disposable database.
      const liveRate = await catalog.addRate(pickupAdmin, pricedCategory.id, new Date(nowMs + 3600_000).toISOString(), 2000);
      await accountPool.query("UPDATE kabadi_catalog.rates SET effective_from = now() - interval '1 hour' WHERE id=$1",[liveRate.id]);
      // A future-dated rate must not be picked for a request made now.
      await catalog.addRate(pickupAdmin, pricedCategory.id, new Date(nowMs + 7200_000).toISOString(), 9999);
      const request = { requestKey:randomUUID(), categoryId:pricedCategory.id, estimatedGrams:2500 };
      assert.equal(await pickups.create(otherId, request), 'forbidden');
      const race = await Promise.all([pickups.create(userId, request), pickups.create(userId, request)]);
      assert.equal(race.filter(r=>r.outcome==='created').length, 1, 'a concurrent retry must not double-insert');
      assert.equal(race.filter(r=>r.outcome==='replayed').length, 1);
      const created = race.find(r=>r.outcome==='created').estimate;
      const replayed = race.find(r=>r.outcome==='replayed').estimate;
      assert.deepEqual(replayed, created);
      assert.equal(created.rateId, liveRate.id, 'the effective rate is chosen, never the future one');
      assert.equal(created.paisePerKg, 2000);
      assert.equal(created.amountPaise, '5000', '2500 g at 2000 paise/kg is exactly 5000 paise');
      assert.equal((await pickups.create(userId, {...request, estimatedGrams:2501})).outcome, 'conflict', 'same key, different weight');
      assert.equal((await pickups.create(userId, {...request, categoryId:randomUUID()})).outcome, 'conflict', 'same key, different category');

      let mine = await pickups.list(userId);
      assert.equal(mine.length, 1);
      assert.equal(mine[0].categoryName, 'Pickup priced synthetic');
      assert.equal(mine[0].paisePerKg, 2000);
      assert.equal(mine[0].amountPaise, '5000');
      assert.equal(mine[0].material, null);

      // A later rate must not rewrite the stored snapshot.
      await accountPool.query("INSERT INTO kabadi_catalog.rates (id,category_id,effective_from,paise_per_kg,created_by) VALUES ($1,$2,now() - interval '30 minutes',7777,$3)",[randomUUID(),pricedCategory.id,pickupAdmin]);
      assert.equal((await pickups.list(userId))[0].amountPaise, '5000', 'stored estimate must be immutable');
      const later = await pickups.create(userId, { requestKey:randomUUID(), categoryId:pricedCategory.id, estimatedGrams:2500 });
      assert.equal(later.outcome, 'created');
      assert.equal(later.estimate.paisePerKg, 7777, 'a new request picks the newest effective rate');
      assert.equal(later.estimate.amountPaise, '19443', '2500 g at 7777 paise/kg = 19442.5 paise, tie rounds up');

      // Half-paise ties round up, per the approved policy: 1 g at 500 paise/kg = 0.5 paise -> 1.
      const tieCategory = await catalog.createCategory(pickupAdmin, 'Pickup tie synthetic');
      const tieRate = await catalog.addRate(pickupAdmin, tieCategory.id, new Date(nowMs + 3600_000).toISOString(), 500);
      await accountPool.query("UPDATE kabadi_catalog.rates SET effective_from = now() - interval '2 hours' WHERE id=$1",[tieRate.id]);
      const tie = await pickups.create(userId, { requestKey:randomUUID(), categoryId:tieCategory.id, estimatedGrams:1 });
      assert.equal(tie.outcome, 'created');
      assert.equal(tie.estimate.amountPaise, '1');

      // No effective rate fails closed instead of guessing a price.
      const bareCategory = await catalog.createCategory(pickupAdmin, 'Pickup no-rate synthetic');
      assert.equal((await pickups.create(userId, { requestKey:randomUUID(), categoryId:bareCategory.id, estimatedGrams:100 })).outcome, 'no-rate');
      // Unknown and deactivated categories are refused the same way.
      assert.equal((await pickups.create(userId, { requestKey:randomUUID(), categoryId:randomUUID(), estimatedGrams:100 })).outcome, 'unknown-category');
      await accountPool.query('UPDATE kabadi_catalog.categories SET active=false WHERE id=$1',[bareCategory.id]);
      assert.equal((await pickups.create(userId, { requestKey:randomUUID(), categoryId:bareCategory.id, estimatedGrams:100 })).outcome, 'unknown-category');

      // The address is snapshotted at request time.
      await details.write(userId, {...record, addressLine:'New test road'});
      const afterAddressChange = await pickups.list(userId);
      assert.equal(afterAddressChange.length, 3);
      assert.ok(afterAddressChange.every(p => p.address.addressLine === '12 Example Road'));
      await details.write(userId, record);

      // Migrating again is a no-op and keeps the priced rows readable.
      await migratePickups(accountPool);
      assert.equal((await pickups.list(userId)).length, 3);

      // A storage failure inside the write transaction leaves nothing behind.
      await accountPool.query('ALTER TABLE kabadi_pickup.requests ADD CONSTRAINT test_failure CHECK (amount_paise <> 4242)');
      const failCategory = await catalog.createCategory(pickupAdmin, 'Pickup fail synthetic');
      const failRate = await catalog.addRate(pickupAdmin, failCategory.id, new Date(nowMs + 3600_000).toISOString(), 4242);
      await accountPool.query("UPDATE kabadi_catalog.rates SET effective_from = now() - interval '1 hour' WHERE id=$1",[failRate.id]);
      try {
        await assert.rejects(pickups.create(userId, { requestKey:randomUUID(), categoryId:failCategory.id, estimatedGrams:1000 }));
        assert.equal((await pickups.list(userId)).length, 3, 'a failed insert must not persist a row');
      } finally { await accountPool.query('ALTER TABLE kabadi_pickup.requests DROP CONSTRAINT test_failure'); }

      // Suspension and role loss both close the door.
      await accountPool.query("UPDATE kabadi_authz.accounts SET status='suspended' WHERE user_id=$1", [userId]);
      assert.equal(await pickups.list(userId), 'forbidden');
      assert.equal(await pickups.create(userId, {...request, requestKey:randomUUID()}), 'forbidden');
      await accountPool.query("UPDATE kabadi_authz.accounts SET status='active' WHERE user_id=$1", [userId]);
      await accountPool.query("DELETE FROM kabadi_authz.role_grants WHERE user_id=$1 AND role='customer'", [userId]);
      assert.equal(await pickups.list(userId), 'forbidden');
      assert.equal(await pickups.create(userId, {...request, requestKey:randomUUID()}), 'forbidden');
      await accountPool.query("INSERT INTO kabadi_authz.role_grants VALUES ($1, 'customer')", [userId]);

      // Cleanup for the HTTP section below, which re-posts the same request key.
      await accountPool.query('DELETE FROM kabadi_pickup.requests WHERE user_id=$1', [userId]);

      const pickupPath = '/api/v1/customer/pickups';
      for (const base of [apiOrigin, publicOrigin]) {
        const send = (body, origin=publicOrigin, extra={}) => fetch(base+pickupPath, {method:'POST', headers:{origin, 'content-type':'application/json', ...extra}, body:JSON.stringify(body)});
        assert.equal((await fetch(base+pickupPath)).status, 401);
        assert.equal((await send(request, publicOrigin, {cookie:cookie+'x'})).status, 401);
        assert.equal((await send(request, 'https://evil.example', {cookie})).status, 403);
        assert.equal((await send({...request, userId:otherId}, publicOrigin, {cookie})).status, 400);
        // A client-supplied price is rejected, never trusted.
        assert.equal((await send({...request, paisePerKg:1}, publicOrigin, {cookie})).status, 400);
        const fresh = {...request, requestKey:randomUUID()};
        const posted = await send(fresh, publicOrigin, {cookie,'x-user-id':otherId});
        assert.equal(posted.status, 200);
        const postedBody = await posted.json();
        assert.equal(postedBody.data.created, true);
        assert.equal(postedBody.data.estimate.amountPaise, '19443', '2500 g at the newest effective rate (7777 paise/kg)');
        // A replay returns the stored estimate and is flagged as not new.
        const again = await send(fresh, publicOrigin, {cookie});
        assert.equal(again.status, 200);
        const againBody = await again.json();
        assert.equal(againBody.data.created, false);
        assert.deepEqual(againBody.data.estimate, postedBody.data.estimate);
        // The same key with a different weight is a conflict, not a silent overwrite.
        assert.equal((await send({...fresh, estimatedGrams:100}, publicOrigin, {cookie})).status, 409);
        const listed = await fetch(base+pickupPath, {headers:{cookie,'x-user-id':otherId}});
        assert.equal(listed.status, 200); assert.equal(listed.headers.get('cache-control'), 'no-store');
        const contents = await listed.json();
        // Each base adds one fresh request, so the list grows across iterations.
        assert.ok(contents.data.pickups.length >= 1);
        assert.ok(contents.data.pickups.every(p => p.status === 'requested' && p.amountPaise === '19443'));
        assert.ok(contents.data.pickups.every(p => !('estimate' in p)), 'the list exposes flat rows, not the create response');
        assert.ok(contents.data.pickups.every(p => p.categoryId === pricedCategory.id && p.material === null));
      }
      // Remove the synthetic pickup catalog fixtures before later catalog reads.
      await accountPool.query('DELETE FROM kabadi_pickup.requests WHERE category_id = ANY($1::uuid[])',[[pricedCategory.id, tieCategory.id, bareCategory.id, failCategory.id]]);
      // Idempotency records reference these rows, so clear them first.
      const pickupFixtures = [pricedCategory.id, tieCategory.id, bareCategory.id, failCategory.id];
      await accountPool.query('DELETE FROM kabadi_catalog_retry.successes WHERE category_id = ANY($1::uuid[])',[pickupFixtures]);
      await accountPool.query('DELETE FROM kabadi_catalog.rates WHERE category_id = ANY($1::uuid[])',[pickupFixtures]);
      await accountPool.query('DELETE FROM kabadi_catalog.categories WHERE id = ANY($1::uuid[])',[pickupFixtures]);
      await accountPool.query("DELETE FROM kabadi_authz.role_grants WHERE user_id=$1 AND role='admin'",[pickupAdmin]);
      await accountPool.query('DELETE FROM kabadi_authz.accounts WHERE user_id=$1',[pickupAdmin]);
      await accountPool.query('DELETE FROM "user" WHERE id=$1',[pickupAdmin]);
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
      assert.equal((await fetch(publicOrigin+catalogPath)).status,401);
      assert.equal((await fetch(publicOrigin+catalogPath,{headers:{cookie,'x-role':'admin'}})).status,403);

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
        const bridged=await fetch(publicOrigin+catalogPath,{headers:{cookie,'x-user-id':'forged','x-role':'admin'}});
        assert.equal(bridged.status,200); assert.equal(bridged.headers.get('cache-control'),'no-store');
        assert.deepEqual(await bridged.json(),{data:{categories:[{id:catId,name:'Synthetic HTTP',active:true}],nextAfter:null}});
        const bridgedRates=await fetch(`${publicOrigin}${catalogPath}/${catId}/rates`,{headers:{cookie}});
        assert.equal(bridgedRates.status,200);
        assert.deepEqual(await bridgedRates.json(),{data:{rates:[{id:rateId,effectiveFrom:'2099-01-01T00:00:00.000Z',paisePerKg:123}],nextAfter:null}});
        assert.equal((await fetch(`${publicOrigin}${catalogPath}?after=bad`,{headers:{cookie}})).status,400);
        // Same-origin write bridge: authorization is still decided by the API,
        // and a cross-site or keyless write must be refused before upstream.
        const bridgeWrite = (body, options = {}) => fetch(publicOrigin + catalogPath, {
          method:'POST',
          headers:{origin: publicOrigin, cookie, 'content-type':'application/json', 'idempotency-key': randomUUID(), ...options.headers},
          body: JSON.stringify(body),
        });
        assert.equal((await bridgeWrite({name:'Bridged'},{headers:{origin:'https://evil.example'}})).status,403);
        assert.equal((await bridgeWrite({name:'Bridged'},{headers:{'idempotency-key':''}})).status,400);
        assert.equal((await bridgeWrite({name:'Bridged',userId:'forged'})).status,400);
        assert.equal((await fetch(publicOrigin + catalogPath,{method:'POST',headers:{origin:publicOrigin,cookie,'content-type':'text/plain','idempotency-key':randomUUID()},body:'{}'})).status,415);
        assert.equal((await fetch(publicOrigin + catalogPath,{method:'POST',headers:{origin:publicOrigin,cookie,'content-type':'application/json','idempotency-key':randomUUID()},body:'x'.repeat(4200)})).status,413);
        const bridgeKey = randomUUID();
        const bridgedWrite = await bridgeWrite({name:'  Bridged synthetic  '},{headers:{'idempotency-key':bridgeKey}});
        assert.equal(bridgedWrite.status,201);
        const bridgedId = (await bridgedWrite.json()).data.id;
        assert.match(bridgedId,/^[0-9a-f-]{36}$/i);
        const bridgedReplay = await bridgeWrite({name:'Bridged synthetic'},{headers:{'idempotency-key':bridgeKey}});
        assert.equal(bridgedReplay.status,201); assert.deepEqual(await bridgedReplay.json(),{data:{id:bridgedId}});
        assert.equal((await bridgeWrite({name:'Bridged different'},{headers:{'idempotency-key':bridgeKey}})).status,409);
        const bridgedRateKey = randomUUID(), bridgedRate = {effectiveFrom:'2099-05-01T00:00:00.000Z',paisePerKg:5400};
        const bridgedRateResponse = await fetch(`${publicOrigin}${catalogPath}/${bridgedId}/rates`,{method:'POST',headers:{origin:publicOrigin,cookie,'content-type':'application/json','idempotency-key':bridgedRateKey},body:JSON.stringify(bridgedRate)});
        assert.equal(bridgedRateResponse.status,201);
        const bridgedRateId = (await bridgedRateResponse.json()).data.id;
        const bridgedRateReplay = await fetch(`${publicOrigin}${catalogPath}/${bridgedId}/rates`,{method:'POST',headers:{origin:publicOrigin,cookie,'content-type':'application/json','idempotency-key':bridgedRateKey},body:JSON.stringify(bridgedRate)});
        assert.equal(bridgedRateReplay.status,201); assert.deepEqual(await bridgedRateReplay.json(),{data:{id:bridgedRateId}});
        assert.deepEqual(await catalog.lookupAt(bridgedId,'2099-05-01T00:00:00.000Z'),{rateId:bridgedRateId,paisePerKg:5400});
        assert.equal((await fetch(`${publicOrigin}${catalogPath}/bad/rates`,{method:'POST',headers:{origin:publicOrigin,cookie,'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify(bridgedRate)})).status,400);
        // A non-admin gets a refusal, never data or a write.
        await client.query("DELETE FROM kabadi_authz.role_grants WHERE user_id=$1 AND role='admin'",[userId]);
        assert.equal((await bridgeWrite({name:'Bridged denied'})).status,403);
        await client.query("INSERT INTO kabadi_authz.role_grants VALUES ($1,'admin')",[userId]);
        await client.query('DELETE FROM kabadi_catalog_retry.successes WHERE category_id=$1',[bridgedId]); // disposable cleanup
        await client.query('DELETE FROM kabadi_catalog.rates WHERE category_id=$1',[bridgedId]);
        await client.query('DELETE FROM kabadi_catalog.categories WHERE id=$1',[bridgedId]);

        assert.equal((await fetch(`${publicOrigin}${catalogPath}/${randomUUID()}/rates`,{headers:{cookie}})).status,404);


        await client.query("UPDATE kabadi_authz.accounts SET status='suspended' WHERE user_id=$1",[userId]);
        assert.equal((await catalogPost(catalogPath, {name:'Denied'})).status,403);
        assert.equal((await catalogPost(catalogPath,{name:'Synthetic HTTP'},cookie,publicOrigin,httpKey)).status,403);
        assert.equal((await catalogGet(catalogPath)).status,403);
        assert.equal((await fetch(publicOrigin+catalogPath,{headers:{cookie}})).status,403);
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
        // The account still owns a pickup row, so deleting it cascades nowhere:
        // RESTRICT must refuse. A direct synthetic row is enough to prove the
        // relationship; the customer grant has already been removed upstream.
        await client.query(`INSERT INTO kabadi_pickup.requests
          (id,user_id,request_key,material,estimated_grams,name,address_line,city,state,postal_code)
          VALUES ($1,$2,$3,'Synthetic legacy',10,'X','Y','Z','W','1')`,[randomUUID(),userId,randomUUID()]);
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
      res.writeHead(mode === 'catalog-write' ? 201 : 200, { 'content-type': 'application/json', 'set-cookie': 'synthetic=refresh; HttpOnly; SameSite=Lax' });
      const body = mode === 'catalog-rate' ? {data:{rates:[{id:'123e4567-e89b-42d3-a456-426614174001',effectiveFrom:'2099-01-01T00:00:00.000Z',paisePerKg:125,createdBy:'secret'}],nextAfter:null},secret:'hidden'} :
        mode === 'catalog' ? {data:{categories:[{id:'123e4567-e89b-42d3-a456-426614174000',name:'Mock',active:true,createdBy:'secret'}],nextAfter:null},secret:'hidden'} :
        mode === 'catalog-write' ? {data:{id:'123e4567-e89b-42d3-a456-426614174002',createdBy:'secret'},secret:'hidden'} :
        mode === 'valid' ? { authenticated: true, token: 'synthetic-secret', user: { name: 'private' } } :
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
      mode = 'catalog';
      const catalogProjection = await fetch(publicOrigin+'/api/v1/admin/catalog/categories');
      assert.deepEqual(await catalogProjection.json(),{data:{categories:[{id:'123e4567-e89b-42d3-a456-426614174000',name:'Mock',active:true}],nextAfter:null}});
      assert.ok(catalogProjection.headers.getSetCookie().some(value=>value.includes('synthetic=refresh')));
      assert.equal((await fetch(publicOrigin+'/api/v1/admin/catalog/categories?after=bad')).status,400);
      assert.equal((await fetch(publicOrigin+'/api/v1/admin/catalog/categories/bad/rates')).status,400);
      mode='catalog-rate';
      const mockRate=await fetch(publicOrigin+'/api/v1/admin/catalog/categories/123e4567-e89b-42d3-a456-426614174000/rates?after=123e4567-e89b-42d3-a456-426614174001');
      assert.deepEqual(await mockRate.json(),{data:{rates:[{id:'123e4567-e89b-42d3-a456-426614174001',effectiveFrom:'2099-01-01T00:00:00.000Z',paisePerKg:125}],nextAfter:null}});

      // The write bridge forwards the idempotency key and only projects the ID.
      mode = 'catalog-write';
      const writeHeaders = { origin: publicOrigin, 'content-type': 'application/json', 'idempotency-key': '123e4567-e89b-42d3-a456-426614174099' };
      const projectedWrite = await fetch(publicOrigin + '/api/v1/admin/catalog/categories', { method:'POST', headers: writeHeaders, body: JSON.stringify({ name:'  Mock  ' }) });
      assert.equal(projectedWrite.status, 201);
      assert.deepEqual(await projectedWrite.json(), { data: { id:'123e4567-e89b-42d3-a456-426614174002' } });
      assert.ok(projectedWrite.headers.getSetCookie().some(value => value.includes('synthetic=refresh')));
      assert.equal((await fetch(publicOrigin + '/api/v1/admin/catalog/categories', { method:'POST', headers:{...writeHeaders, origin:'https://evil.example'}, body:'{"name":"Mock"}' })).status, 403);
      assert.equal((await fetch(publicOrigin + '/api/v1/admin/catalog/categories', { method:'POST', headers:{...writeHeaders, 'idempotency-key':'nope'}, body:'{"name":"Mock"}' })).status, 400);
      assert.equal((await fetch(publicOrigin + '/api/v1/admin/catalog/categories', { method:'POST', headers:writeHeaders, body:'{"name":"Mock","role":"admin"}' })).status, 400);
      mode = 'invalid';
      assert.equal((await fetch(publicOrigin + '/api/v1/admin/catalog/categories', { method:'POST', headers:writeHeaders, body:'{"name":"Mock"}' })).status, 503);
      assert.equal((await fetch(publicOrigin + '/api/v1/admin/catalog/categories')).status, 503);
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
