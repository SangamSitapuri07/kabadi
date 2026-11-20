import type pg from 'pg';
import type { AccountLookup } from './authorization.js';

// The complete set of roles, in hierarchy order. Tier 0 is the customer
// (generator); tiers 1-4 are the upward chain a lot is sold through. `admin`
// is the operator and sits outside the chain.
//
// This list is the single source of truth: the role_grants CHECK constraint, the
// role tool, the account view and the UI filters all read it, so adding a tier is
// a migration plus one line here rather than five scattered edits.
export const ROLES = ['customer', 'collector', 'shop', 'mandi', 'recycler', 'admin'] as const;
export type Role = typeof ROLES[number];
export const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && (ROLES as readonly string[]).includes(value);

// Roles that participate in the upward supply chain, in the only direction a lot
// may travel. A customer sells to a collector; a collector sells to a shop; a
// shop to a mandi; a mandi to a recycler. The recycler is terminal: nothing is
// sold onward from an authorised recycler, because that is where material is
// processed.
export const CHAIN_ROLES = ['customer', 'collector', 'shop', 'mandi', 'recycler'] as const;
export type ChainRole = typeof CHAIN_ROLES[number];
export function nextTier(role: ChainRole): ChainRole | null {
  const index = CHAIN_ROLES.indexOf(role);
  if (index < 0 || index === CHAIN_ROLES.length - 1) return null;
  return CHAIN_ROLES[index + 1] ?? null;
}
export function tierOf(role: ChainRole): number {
  return CHAIN_ROLES.indexOf(role);
}

// Development schema v1. No roles or accounts are created by this migration.
// Privileged role provisioning requires a separately designed, audited workflow.
export async function migrateAccountStore(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize concurrent invocations within this database.
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [1262572353, 1]);
    const existing = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'kabadi_authz') AS exists",
    );
    if (existing.rows[0]?.exists) {
      // An existing unrecognized schema is never modified or adopted silently.
      const marker = await client.query<{ marker: string | null }>("SELECT to_regclass('kabadi_authz.schema_version')::text AS marker");
      if (!marker.rows[0]?.marker) throw new Error('Unrecognized authorization schema');
      const versions = await client.query<{ version: number }>('SELECT version FROM kabadi_authz.schema_version');
      const version = versions.rows.length === 1 ? versions.rows[0]?.version : undefined;
      if (![1, 2].includes(version as number)) throw new Error('Unsupported authorization schema version');
      if (version === 1) {
        // Version 2 adds the three upward-chain tiers. Existing grants are all
        // still valid values, so nothing is rewritten; only the constraint
        // widens. Widening a CHECK can never fail on existing rows.
        await client.query('ALTER TABLE kabadi_authz.role_grants DROP CONSTRAINT IF EXISTS role_grants_role_check');
        await client.query(`ALTER TABLE kabadi_authz.role_grants ADD CONSTRAINT role_grants_role_check
          CHECK (role IN (${ROLES.map(r => `'${r}'`).join(', ')}))`);
        await client.query('ALTER TABLE kabadi_authz.schema_version DROP CONSTRAINT IF EXISTS schema_version_version_check');
        await client.query('UPDATE kabadi_authz.schema_version SET version = 2');
        await client.query('ALTER TABLE kabadi_authz.schema_version ADD CONSTRAINT schema_version_version_check CHECK (version = 2)');
      }
    } else {
      await client.query('CREATE SCHEMA kabadi_authz');
      await client.query('CREATE TABLE kabadi_authz.schema_version (version integer PRIMARY KEY CHECK (version = 2))');
      await client.query('CREATE TABLE kabadi_authz.accounts (user_id text PRIMARY KEY REFERENCES public."user"(id) ON DELETE CASCADE, status text NOT NULL CHECK (status IN (\'active\', \'suspended\')))');
      await client.query(`CREATE TABLE kabadi_authz.role_grants (user_id text NOT NULL REFERENCES kabadi_authz.accounts(user_id) ON DELETE CASCADE, role text NOT NULL CHECK (role IN (${ROLES.map(r => `'${r}'`).join(', ')})), PRIMARY KEY (user_id, role))`);
      await client.query('INSERT INTO kabadi_authz.schema_version (version) VALUES (2)');
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
    throw error;
  } finally { client.release(); }
}

// One statement reads account and grants from a single PostgreSQL snapshot.
// Missing account is distinct from a database failure; no data is cached.
export function createAccountLookup(pool: pg.Pool): AccountLookup {
  return async userId => {
    const result = await pool.query<{ status: unknown; roles: unknown }>(
      `SELECT a.status, COALESCE(array_agg(g.role ORDER BY g.role)
        FILTER (WHERE g.role IS NOT NULL), ARRAY[]::text[]) AS roles
       FROM kabadi_authz.accounts AS a
       LEFT JOIN kabadi_authz.role_grants AS g ON g.user_id = a.user_id
       WHERE a.user_id = $1 GROUP BY a.user_id, a.status`, [userId],
    );
    return result.rows[0] ?? null;
  };
}
