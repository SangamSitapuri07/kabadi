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
  await migratePickups(pool);
  console.log('Pickup schema migration completed; no pickup requests were created.');
} catch {
  console.error('Pickup migration failed; check development configuration and schemas.');
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
  if (auth) await auth.close();
}
