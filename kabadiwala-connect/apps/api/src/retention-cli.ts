import pg from 'pg';
import { createAuthRuntime, readAuthConfig } from './auth.js';
import { createRetentionStore, ADDRESS_RETENTION_DAYS, READ_NOTIFICATION_RETENTION_DAYS, UNREAD_NOTIFICATION_RETENTION_DAYS } from './retention.js';

// Dry by default: running this with no flags prints the plan and changes nothing.
// Deletion requires an explicit second flag, and then a separate confirmation,
// because an irreversible operation should never be one argument away from a
// typo in a script.
const APPLY = process.argv.includes('--apply');
const LIMIT_ARG = process.argv.find(arg => arg.startsWith('--limit='));
const limit = LIMIT_ARG ? Number(LIMIT_ARG.slice('--limit='.length)) : undefined;

const knownReasons = new Map<string, string>([
  ['Auth is disabled.', 'auth is disabled; AUTH_ENABLED is not set to true.'],
  ['Google auth configuration is incomplete.', 'required settings are missing (AUTH_PUBLIC_ORIGIN, DATABASE_URL, BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET).'],
  ['Invalid limit', '--limit must be a whole number between 1 and 5000.'],
  ['Prerequisite schema missing', 'the auth, authorization, customer or catalog schema is missing.'],
]);

let auth: ReturnType<typeof createAuthRuntime> | undefined;
let pool: pg.Pool | undefined;
try {
  if (APPLY && process.env.RETENTION_APPLY_CONFIRM !== 'yes') {
    console.error('Applying a retention sweep needs RETENTION_APPLY_CONFIRM=yes. Nothing was changed.');
    process.exitCode = 1;
  } else {
    const config = readAuthConfig(process.env);
    if (!config) throw new Error('Auth is disabled.');
    auth = createAuthRuntime(config);
    const status = await auth.schemaStatus();
    if (status.missing || status.problems) throw new Error('Authentication schema is not ready.');
    pool = new pg.Pool({ connectionString: config.databaseURL, max: 1, connectionTimeoutMillis: 5000 });
    pool.on('error', () => console.error('An idle pickup database connection failed.'));
    const marker = await pool.query<{ marker: string | null }>(
      "SELECT to_regclass('kabadi_pickup.notifications')::text AS marker");
    if (!marker.rows[0]?.marker) throw new Error('Prerequisite schema missing');
    const store = createRetentionStore(pool);

    console.log(`Retention: addresses are removed ${ADDRESS_RETENTION_DAYS} days after a request closes; read notifications after ${READ_NOTIFICATION_RETENTION_DAYS} days; unread ones after ${UNREAD_NOTIFICATION_RETENTION_DAYS} days.`);
    // Say the permanent half out loud every run. An operator reading a sweep log
    // should not have to remember which tables the sweep can never touch.
    console.log('Payouts and the requests they settle are never deleted: the ledger is permanent.');

    if (APPLY) {
      const report = await store.apply(limit);
      const { applied } = report;
      console.log(`Retention applied in one transaction at limit ${limit ?? 500}:`);
      console.log(`  addresses removed: ${applied['redact-address']}`);
      console.log(`  read notifications deleted: ${applied['delete-read-notification']}`);
      console.log(`  unread notifications deleted: ${applied['delete-unread-notification']}`);
      if (report.truncated) console.log('The per-call cap was reached; run again to continue.');
      // A planned action that did not apply means a row changed underneath the
      // plan -- usually a dispute arriving. That is the guard working, not an
      // error, but the operator should see it.
      const skipped = report.counts['redact-address'] - applied['redact-address'];
      if (skipped > 0) console.log(`${skipped} planned address removal(s) were skipped because the row changed since the plan was read.`);
    } else {
      const plan = await store.plan(limit);
      if (!plan.actions.length) {
        console.log('Nothing is past its retention window. Nothing would change.');
      } else {
        console.log(`Dry run at limit ${limit ?? 500}. Nothing was changed. Pass --apply with RETENTION_APPLY_CONFIRM=yes to perform this plan:`);
        console.log(`  addresses that would be removed: ${plan.counts['redact-address']}`);
        console.log(`  read notifications that would be deleted: ${plan.counts['delete-read-notification']}`);
        console.log(`  unread notifications that would be deleted: ${plan.counts['delete-unread-notification']}`);
        for (const action of plan.actions.slice(0, 20)) {
          if (action.kind === 'redact-address') console.log(`  - request ${action.requestId}: ${action.reason}`);
          else console.log(`  - notification ${action.notificationId}: ${action.reason}`);
        }
        if (plan.actions.length > 20) console.log(`  ... and ${plan.actions.length - 20} more.`);
        if (plan.truncated) console.log('The per-call cap was reached; this plan is not the whole picture.');
      }
    }
  }
} catch (error) {
  const hint = !process.env.AUTH_ENABLED && !process.env.DATABASE_URL;
  const reason = error instanceof Error ? knownReasons.get(error.message) : undefined;
  if (hint) console.error('Could not run retention. No configuration was loaded. Run this from the kabadiwala-connect directory.');
  else if (reason) console.error(`Could not run retention: ${reason}`);
  else if (error instanceof Error && error.message === 'Authentication schema is not ready.') console.error('Could not run retention: the authentication schema is missing or incomplete; run the auth migrations first.');
  else console.error('Could not run retention: the database could not be reached. Check development configuration.');
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
  if (auth) await auth.close();
}
