import type pg from 'pg';
import type { AccountLookup } from './authorization.js';

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
      if (versions.rows.length !== 1 || versions.rows[0]?.version !== 1) throw new Error('Unsupported authorization schema version');
    } else {
      await client.query('CREATE SCHEMA kabadi_authz');
      await client.query('CREATE TABLE kabadi_authz.schema_version (version integer PRIMARY KEY CHECK (version = 1))');
      await client.query('CREATE TABLE kabadi_authz.accounts (user_id text PRIMARY KEY REFERENCES public."user"(id) ON DELETE CASCADE, status text NOT NULL CHECK (status IN (\'active\', \'suspended\')))');
      await client.query('CREATE TABLE kabadi_authz.role_grants (user_id text NOT NULL REFERENCES kabadi_authz.accounts(user_id) ON DELETE CASCADE, role text NOT NULL CHECK (role IN (\'customer\', \'collector\', \'admin\')), PRIMARY KEY (user_id, role))');
      await client.query('INSERT INTO kabadi_authz.schema_version (version) VALUES (1)');
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
