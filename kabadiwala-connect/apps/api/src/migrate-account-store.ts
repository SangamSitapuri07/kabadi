import { closeDatabasePool, getDatabasePool } from './embedded-pg.js';
import { createAuthRuntime, readAuthConfig } from './auth.js';
import { migrateAccountStore } from './account-store.js';

// Explicit opt-in only. Never invoked at application startup.
if (process.env.AUTHORIZATION_MIGRATION_CONFIRM !== 'yes') {
  console.error('Set AUTHORIZATION_MIGRATION_CONFIRM=yes only for a disposable development database.');
  process.exit(1);
}
let auth: ReturnType<typeof createAuthRuntime> | undefined;
let pool: Awaited<ReturnType<typeof getDatabasePool>> | undefined;
try {
  const config = readAuthConfig(process.env);
  if (!config) throw new Error('Auth is disabled.');
  auth = createAuthRuntime(config);
  const status = await auth.schemaStatus();
  if (status.missing || status.problems) throw new Error('Authentication schema is not ready.');
  // Embedded PostgreSQL when no DATABASE_URL was supplied, external when it was.
  // Constructing `new pg.Pool` here would bypass that switch and leave the
  // embedded default unable to migrate at all.
  pool = await getDatabasePool(config.databaseURL);
  pool.on('error', () => console.error('An idle authorization database connection failed.'));
  await migrateAccountStore(pool);
  console.log('Authorization schema migration completed; no accounts or roles were created.');
} catch {
  console.error('Authorization migration failed; check the development configuration and schemas.');
  process.exitCode = 1;
} finally {
  // The shared closer shuts down whichever pool was used -- the embedded
  // database holds the process open otherwise, and a migration that never exits
  // looks identical to one that hung.
  await closeDatabasePool();
  if (auth) await auth.close();
}
