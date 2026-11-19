import pg from 'pg';
import { createAuthRuntime, readAuthConfig } from './auth.js';
import { migratePickups } from './pickups.js';

if (process.env.PICKUP_MIGRATION_CONFIRM !== 'yes') {
  console.error('Set PICKUP_MIGRATION_CONFIRM=yes only for a disposable development database.');
  process.exit(1);
}
let auth: ReturnType<typeof createAuthRuntime> | undefined;
let pool: pg.Pool | undefined;
try {
  const config = readAuthConfig(process.env);
  if (!config) throw new Error('Auth is disabled.');
  auth = createAuthRuntime(config);
  const status = await auth.schemaStatus();
  if (status.missing || status.problems) throw new Error('Authentication schema is not ready.');
  pool = new pg.Pool({ connectionString: config.databaseURL, max: 1, connectionTimeoutMillis: 5000 });
  pool.on('error', () => console.error('An idle pickup database connection failed.'));
  const report = await migratePickups(pool);
  // Say exactly what happened, especially on an upgrade: legacy rows are kept
  // as-is and deliberately get no invented estimate.
  if (report.action === 'created') {
    console.log('Pickup schema created at version 2; no pickup requests exist yet.');
  } else if (report.action === 'upgraded') {
    console.log(`Pickup schema upgraded from version 1 to version 2. All existing requests were kept.`);
    if (report.legacyRequests > 0) {
      console.log(`${report.legacyRequests} pre-pricing request(s) keep their free-text material and have no estimate. New requests will be priced from the catalog.`);
    }
  } else {
    console.log('Pickup schema is already version 2; nothing changed.');
    if (report.legacyRequests > 0) {
      console.log(`${report.legacyRequests} pre-pricing request(s) still have no estimate.`);
    }
  }
} catch {
  console.error('Pickup migration failed; check development configuration and schemas. No changes were committed.');
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
  if (auth) await auth.close();
}
