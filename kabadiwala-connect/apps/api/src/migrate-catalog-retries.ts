import { closeDatabasePool, getDatabasePool } from './embedded-pg.js';
import { createAuthRuntime, readAuthConfig } from './auth.js';
import { migrateCatalogRetries } from './catalog-retries.js';

if (process.env.CATALOG_RETRY_MIGRATION_CONFIRM !== 'yes') {
  console.error('Set CATALOG_RETRY_MIGRATION_CONFIRM=yes only for a disposable development database.');
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
  pool.on('error', () => console.error('An idle catalog retry database connection failed.'));
  await migrateCatalogRetries(pool);
  console.log('Catalog retry schema migration completed; no categories, rates or retry records were created.');
} catch {
  console.error('Catalog retry migration failed; check development configuration and schemas.');
  process.exitCode = 1;
} finally { // The shared closer shuts down whichever pool was used -- the embedded
  // database holds the process open otherwise, and a migration that never exits
  // looks identical to one that hung.
  await closeDatabasePool(); if (auth) await auth.close(); }
