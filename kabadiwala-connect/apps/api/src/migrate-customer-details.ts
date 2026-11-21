import { closeDatabasePool, getDatabasePool } from './embedded-pg.js';
import { createAuthRuntime, readAuthConfig } from './auth.js';
import { migrateCustomerDetails } from './customer-details.js';

if (process.env.CUSTOMER_DETAILS_MIGRATION_CONFIRM !== 'yes') {
  console.error('Set CUSTOMER_DETAILS_MIGRATION_CONFIRM=yes only for a disposable development database.');
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
  pool.on('error', () => console.error('An idle customer database connection failed.'));
  await migrateCustomerDetails(pool);
  console.log('Customer details schema migration completed; no customer data was created.');
} catch {
  console.error('Customer details migration failed; check development configuration and schemas.');
  process.exitCode = 1;
} finally {
  // The shared closer shuts down whichever pool was used -- the embedded
  // database holds the process open otherwise, and a migration that never exits
  // looks identical to one that hung.
  await closeDatabasePool();
  if (auth) await auth.close();
}
