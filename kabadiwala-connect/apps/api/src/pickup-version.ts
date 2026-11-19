import pg from 'pg';
import { createAuthRuntime, readAuthConfig } from './auth.js';

// Read-only. Reports the recorded pickup schema version so an operator can tell
// whether a migration actually ran, instead of inferring it from log wording.
const knownReasons = new Map<string, string>([
  ['Auth is disabled.', 'auth is disabled; AUTH_ENABLED is not set to true.'],
  ['Google auth configuration is incomplete.', 'required settings are missing (AUTH_PUBLIC_ORIGIN, DATABASE_URL, BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET).'],
]);

let auth: ReturnType<typeof createAuthRuntime> | undefined;
let pool: pg.Pool | undefined;
try {
  const config = readAuthConfig(process.env);
  if (!config) throw new Error('Auth is disabled.');
  auth = createAuthRuntime(config);
  pool = new pg.Pool({ connectionString: config.databaseURL, max: 1, connectionTimeoutMillis: 5000 });
  pool.on('error', () => console.error('An idle pickup database connection failed.'));
  const marker = await pool.query<{ marker: string | null }>("SELECT to_regclass('kabadi_pickup.schema_version')::text AS marker");
  if (!marker.rows[0]?.marker) {
    console.log('Pickup schema is not migrated yet (schema version 0). Run the pickup migration.');
  } else {
    const rows = await pool.query<{ version: number }>('SELECT version FROM kabadi_pickup.schema_version');
    const version = rows.rows[0]?.version;
    // A version row is only a claim; the collector slice needs these columns to
    // actually exist. Checking both is what tells "already migrated" apart from
    // "recorded as migrated but the columns are missing".
    const expected = ['collector_id', 'accepted_at', 'collected_at', 'actual_grams',
      'final_rate_id', 'final_paise_per_kg', 'final_amount_paise',
      'cancelled_at', 'cancellation_reason', 'released_at'];
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='kabadi_pickup' AND table_name='requests' AND column_name = ANY($1::text[])`, [expected]);
    const present = new Set(columns.rows.map(r => r.column_name));
    const missing = expected.filter(name => !present.has(name));
    console.log(`Pickup schema version: ${version ?? 'unrecognized'} (expected 4).`);
    if (version !== 4) {
      console.log('Run the pickup migration to upgrade it.');
    } else if (missing.length) {
      // The recorded version and the real table disagree; never report success.
      console.log(`The recorded version is 4 but the table is missing: ${missing.join(', ')}.`);
      console.log('The version row does not match the table. Inspect and restore before relying on this database.');
      process.exitCode = 1;
    } else {
      console.log('Collector columns present: acceptance, measured weight and the final amount are available.');
    }
  }
} catch (error) {
  const hint = !process.env.AUTH_ENABLED && !process.env.DATABASE_URL;
  const reason = error instanceof Error ? knownReasons.get(error.message) : undefined;
  if (hint) console.error('Could not read the schema version. No configuration was loaded. Run this from the kabadiwala-connect directory.');
  else if (reason) console.error(`Could not read the schema version: ${reason}`);
  else console.error('Could not read the schema version: the database could not be reached. Check development configuration.');
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
  if (auth) await auth.close();
}
