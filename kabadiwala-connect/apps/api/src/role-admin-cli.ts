import pg from 'pg';
import { createAuthRuntime, readAuthConfig } from './auth.js';
import { createRoleAdmin, normalizeEmail, normalizeReason, normalizeRole, REASONS_MIN } from './role-admin.js';

// Validate arguments before touching the database, and say precisely which one
// is wrong. A single generic message made a mistyped email look like a schema
// failure during a real operator session.
function describeEmailProblem(input: string | undefined): string | null {
  if (input === undefined) return 'Missing email argument.';
  if (normalizeEmail(input)) return null;
  if (/[[\]]|mailto:/i.test(input)) {
    return 'The email contains bracketed or "mailto:" link formatting. Type the bare address, e.g. "name@example.com".';
  }
  return 'The email is not a valid address. Use the bare address, e.g. "name@example.com", with quotes and no extra text.';
}
function describeRoleProblem(input: string | undefined): string | null {
  if (input === undefined) return `Missing role argument. Use one of: customer, collector, admin.`;
  return normalizeRole(input) ? null : `Invalid role "${input}". Use exactly: customer, collector, or admin.`;
}
function describeReasonProblem(input: string | undefined): string | null {
  if (input === undefined) return 'Missing reason argument. Wrap the reason in quotes.';
  if (normalizeReason(input)) return null;
  const length = Array.from(input.trim()).length;
  if (length < REASONS_MIN) return `The reason is too short (${length} characters; at least ${REASONS_MIN} are required). Wrap it in quotes.`;
  return 'The reason is too long or contains control characters. Use plain text, 10-200 characters, in quotes.';
}

// Local operator tool for development role grants. There is no HTTP surface and
// this script must never run against production data.
if (process.env.DEV_ROLE_TOOL_CONFIRM !== 'yes') {
  console.error('Set DEV_ROLE_TOOL_CONFIRM=yes only for an approved disposable development database.');
  process.exit(1);
}
const NODE_ENV = process.env.NODE_ENV;
if (NODE_ENV === 'production') {
  console.error('This development role tool refuses to run in production mode.');
  process.exit(1);
}
const usage = 'Usage: node apps/api/dist/role-admin-cli.js <list|users|grant|revoke> ... (see README)';
const [command, ...rest] = process.argv.slice(2);
// Arguments are checked before any database connection so a typo is reported as
// a typo, never as a configuration or schema failure.
const argumentProblem = !['grant', 'revoke', 'list', 'users'].includes(command) ? usage
  : (command === 'list' || command === 'users') ? (rest.length === 0 ? null : `${command} takes no arguments.`)
  : rest.length !== 3 ? `${command} requires exactly three arguments: <email> <role> "<reason>"`
  : describeEmailProblem(rest[0]) ?? describeRoleProblem(rest[1]) ?? describeReasonProblem(rest[2]);
if (argumentProblem) {
  console.error(argumentProblem);
  process.exitCode = 1;
} else {
  let auth: ReturnType<typeof createAuthRuntime> | undefined;
  let pool: pg.Pool | undefined;
  try {
    const config = readAuthConfig(process.env);
    if (!config) throw new Error('Auth is disabled.');
    auth = createAuthRuntime(config);
    const status = await auth.schemaStatus();
    if (status.missing || status.problems) throw new Error('Authentication schema is not ready.');
    pool = new pg.Pool({ connectionString: config.databaseURL, max: 1, connectionTimeoutMillis: 5000 });
    pool.on('error', () => console.error('An idle role-tool connection failed.'));
    const tool = createRoleAdmin(pool);
    if (command === 'users') {
      // Masked output only; never print full addresses or IDs in a terminal.
      const { total, users } = await tool.listUsers(50);
      console.log(`Application users: ${total}${total > users.length ? ` (showing first ${users.length})` : ''}`);
      if (!users.length) console.log('No users have signed in yet.');
      for (const user of users) {
        const state = user.status === null ? 'no account (customer setup not completed)' : `${user.status}${user.roles.length ? ` [${user.roles.join(',')}]` : ''}`;
        console.log(`${user.email} — ${state}`);
      }
    } else if (command === 'list') {
      const changes = await tool.recentChanges(20);
      console.log(`Active administrators: ${await tool.activeAdminCount()}`);
      if (!changes.length) console.log('No recorded role changes.');
      for (const change of changes) {
        console.log(`${change.changedAt} ${change.action} ${change.role} ${change.email} — ${change.reason}`);
      }
    } else {
      const [email, role, reason] = rest as [string, string, string];
      const result = command === 'grant' ? await tool.grant(email, role, reason) : await tool.revoke(email, role, reason);
      // A resolved account state is a normal answer, not a tool failure: report
      // it plainly and exit without the schema/configuration hint.
      const resolvedProblem = result.outcome === 'unknown-user'
        ? 'No application user exists with that email. Sign in once with that Google account, then retry.'
        : result.outcome === 'no-account'
        ? 'That user exists but has no application account yet. Complete "Set up customer account" on the site, then retry.'
        : result.outcome === 'suspended-account'
        ? 'That account is suspended; resolve its status before changing roles.'
        : null;
      if (resolvedProblem) {
        console.error(resolvedProblem);
        process.exitCode = 1;
      } else if (result.outcome === 'changed' || result.outcome === 'already-granted' || result.outcome === 'already-absent') {
        if (result.outcome === 'changed') {
          console.log(`${command === 'grant' ? 'Granted' : 'Revoked'} ${result.role} for ${email}.`);
          // A grant/revoke should never be silently ambiguous; state the count.
          console.log(`Active administrators now: ${await tool.activeAdminCount()}`);
        } else {
          console.log(`That account ${result.outcome === 'already-granted' ? 'already has' : 'does not have'} ${result.role}; nothing changed.`);
        }
        if (command === 'revoke' && role === 'admin' && (await tool.activeAdminCount()) === 0) {
          console.log('Warning: no active administrators remain. Admin routes are now unusable until a grant is restored.');
        }
      } else throw new Error('Unexpected result');
    }
  } catch (error) {
    // Only unexpected outcomes reach here (configuration, schema, database).
    // Argument problems are reported above with their own message.
    console.error(`Role tool failed: ${error instanceof Error ? error.message : 'unexpected error'}`);
    console.error('Check development configuration and schemas.');
    process.exitCode = 1;
  } finally { if (pool) await pool.end(); if (auth) await auth.close(); }
}
