import pg from 'pg';
import { createAuthRuntime, readAuthConfig } from './auth.js';
import { migrateAccountStore } from './account-store.js';

// Explicit opt-in only. Never invoked at application startup.
if (process.env.AUTHORIZATION_MIGRATION_CONFIRM !== 'yes') {
  console.error('Set AUTHORIZATION_MIGRATION_CONFIRM=yes only for a disposable development database.');
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
  pool.on('error', () => console.error('An idle authorization database connection failed.'));
  await migrateAccountStore(pool);
  console.log('Authorization schema migration completed; no accounts or roles were created.');
} catch {
  console.error('Authorization migration failed; check the development configuration and schemas.');
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
  if (auth) await auth.close();
}
