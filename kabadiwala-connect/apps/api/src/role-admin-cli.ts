import pg from 'pg';
import { createAuthRuntime, readAuthConfig } from './auth.js';
import { createRoleAdmin } from './role-admin.js';

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
const usage = 'Usage: node apps/api/dist/role-admin-cli.js <grant|revoke|list> ... (see README)';
const [command, ...rest] = process.argv.slice(2);
if (!['grant', 'revoke', 'list'].includes(command)) {
  console.error(usage);
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
    if (command === 'list') {
      if (rest.length !== 0) throw new Error('list takes no arguments');
      const changes = await tool.recentChanges(20);
      console.log(`Active administrators: ${await tool.activeAdminCount()}`);
      if (!changes.length) console.log('No recorded role changes.');
      for (const change of changes) {
        console.log(`${change.changedAt} ${change.action} ${change.role} ${change.email} — ${change.reason}`);
      }
    } else {
      if (rest.length !== 3) throw new Error(`${command} requires <email> <role> <reason>`);
      const [email, role, reason] = rest;
      const result = command === 'grant' ? await tool.grant(email, role, reason) : await tool.revoke(email, role, reason);
      switch (result.outcome) {
        case 'changed':
          console.log(`${command === 'grant' ? 'Granted' : 'Revoked'} ${result.role} for ${email}.`);
          // A grant/revoke should never be silently ambiguous; state the count.
          console.log(`Active administrators now: ${await tool.activeAdminCount()}`);
          break;
        case 'already-granted': console.log(`That account already has ${result.role}; nothing changed.`); break;
        case 'already-absent': console.log(`That account does not have ${result.role}; nothing changed.`); break;
        case 'unknown-user': throw new Error('No application user exists with that email. Sign in once first.');
        case 'no-account': throw new Error('That user has no application account. Use customer setup or a reviewed onboarding flow first.');
        case 'suspended-account': throw new Error('That account is suspended; resolve the status first.');
        default: throw new Error('Unexpected result');
      }
      if (command === 'revoke' && role === 'admin' && (await tool.activeAdminCount()) === 0) {
        console.log('Warning: no active administrators remain. Admin routes are now unusable until a grant is restored.');
      }
    }
  } catch (error) {
    console.error('Role tool failed; check development configuration, arguments and schemas.');
    process.exitCode = 1;
  } finally { if (pool) await pool.end(); if (auth) await auth.close(); }
}
