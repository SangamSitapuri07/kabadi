import pg from 'pg';
import { createAuthRuntime, readAuthConfig } from './auth.js';
import { migratePickups } from './pickups.js';

if (process.env.PICKUP_MIGRATION_CONFIRM !== 'yes') {
  console.error('Set PICKUP_MIGRATION_CONFIRM=yes only for a disposable development database.');
  process.exit(1);
}
// These are the only messages this script may echo. Anything else is reported
// generically, because database errors can embed host and connection details.
const knownReasons = new Map<string, string>([
  ['Auth is disabled.', 'auth is disabled; AUTH_ENABLED is not set to true.'],
  ['Google auth configuration is incomplete.', 'required settings are missing (AUTH_PUBLIC_ORIGIN, DATABASE_URL, BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET).'],
  ['Google auth configuration has invalid URLs.', 'AUTH_PUBLIC_ORIGIN or DATABASE_URL is not a valid URL.'],
  ['AUTH_PUBLIC_ORIGIN must be an exact HTTPS origin (or local HTTP origin).', 'AUTH_PUBLIC_ORIGIN is not an exact origin.'],
  ['DATABASE_URL must identify a PostgreSQL database.', 'DATABASE_URL does not identify a PostgreSQL database.'],
  ['BETTER_AUTH_SECRET must contain at least 32 characters.', 'BETTER_AUTH_SECRET is shorter than 32 characters.'],
  ['Google auth is not yet enabled for production.', 'NODE_ENV is production; this project does not support that.'],
  ['Authentication schema is not ready.', 'the authentication schema is missing or incomplete; run the auth migrations first.'],
  ['Prerequisite schema missing', 'the auth, authorization, customer or catalog schema is missing.'],
  ['Unsupported schema', 'a prerequisite schema is at an unexpected version.'],
]);

// The most common cause by far is running from the wrong directory, which
// skips .env silently. Detect it rather than blaming the schema.
function environmentHint(): string | null {
  const looksEmpty = !process.env.AUTH_ENABLED && !process.env.DATABASE_URL;
  return looksEmpty
    ? 'No configuration was loaded. Run this from the kabadiwala-connect directory, or set the variables explicitly; --env-file resolves against the current directory.'
    : null;
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
    console.log('Pickup schema created at version 8; no pickup requests exist yet.');
  } else if (report.action === 'upgraded') {
    console.log(`Pickup schema upgraded from version ${report.fromVersion} to version 8. All existing requests were kept.`);
    if (report.fromVersion < 8) {
      console.log('Collector acceptance, actual weight, the collection-time final amount, cancellation, releasing a claim, customer disputes, the payout ledger, in-app notifications and the retention marker are now available.');
    }
    if (report.legacyRequests > 0) {
      console.log(`${report.legacyRequests} pre-pricing request(s) keep their free-text material and have no estimate. New requests will be priced from the catalog.`);
    }
  } else {
    console.log('Pickup schema is already version 8; nothing changed.');
    if (report.legacyRequests > 0) {
      console.log(`${report.legacyRequests} pre-pricing request(s) still have no estimate.`);
    }
  }
} catch (error) {
  const hint = environmentHint();
  const raw = error instanceof Error ? error.message : '';
  const reason = knownReasons.get(raw);
  // A schema that lies about its version is not a network problem; say what is
  // wrong so it is not retried blindly.
  if (raw.startsWith('Pickup schema claims version')) {
    console.error('Pickup migration stopped: the recorded version does not match the table.');
    console.error(raw);
    console.error('Inspect the table and restore from a known-good backup before continuing.');
    process.exit(1);
  }
  if (hint) console.error(`Pickup migration failed. ${hint}`);
  else if (reason) console.error(`Pickup migration failed: ${reason}`);
  else console.error('Pickup migration failed: the database could not be reached or refused the change. Check development configuration and schemas.');
  console.error('No changes were committed.');
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
  if (auth) await auth.close();
}
