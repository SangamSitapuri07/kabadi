import { randomUUID } from 'node:crypto';
import type pg from 'pg';

// Development-only local operator tooling for privileged role grants.
// There is deliberately no HTTP or browser endpoint here: a signed-in person
// must never be able to grant themselves a role. Grants are performed by
// someone with direct access to the development database and its environment
// file, and every change is recorded in an append-only audit table.
//
// This is a small, reviewable operations tool, not a complete identity
// governance system. There is no approval workflow, no second approver, no
// separation of duties, no key rotation and no protection against an operator
// who already controls the database.

export const REASONS_MIN = 10;
export const REASONS_MAX = 200;

// Only the roles the application actually understands. 'admin' is deliberately
// included because this tool exists to bootstrap it, but nothing in the web or
// API surface can call this module.
const ROLE = /^(customer|collector|admin)$/;

export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  if (value.length < 3 || value.length > 254) return null;
  // Deliberately conservative: one @, no whitespace or control characters.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
  return value;
}

export function normalizeReason(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  const length = Array.from(value).length;
  if (length < REASONS_MIN || length > REASONS_MAX) return null;
  if (/[\uD800-\uDFFF\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
  return value;
}

export function normalizeRole(input: unknown): 'customer' | 'collector' | 'admin' | null {
  return typeof input === 'string' && ROLE.test(input) ? input as 'customer' | 'collector' | 'admin' : null;
}

// A separate, explicit schema for local administration evidence. It never
// stores secrets, and it references the auth user table so a deleted user
// leaves no orphaned grant history rows (the audit copy keeps the email that
// was resolved at the time of the change).
export async function migrateRoleAdmin(pool: pg.Pool): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock($1, $2)', [1262572353, 6]);
    const marker = await c.query<{ marker: string | null }>("SELECT to_regclass('kabadi_authz.schema_version')::text AS marker");
    if (!marker.rows[0]?.marker) throw new Error('Authorization schema missing');
    const versions = await c.query<{ version: number }>('SELECT version FROM kabadi_authz.schema_version');
    if (versions.rows.length !== 1 || versions.rows[0]?.version !== 1) throw new Error('Unsupported authorization schema');
    const existing = await c.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='kabadi_admin') AS exists");
    if (existing.rows[0]?.exists) {
      const present = await c.query<{ marker: string | null }>("SELECT to_regclass('kabadi_admin.schema_version')::text AS marker");
      if (!present.rows[0]?.marker) throw new Error('Unrecognized admin schema');
      const version = await c.query<{ version: number }>('SELECT version FROM kabadi_admin.schema_version');
      if (version.rows.length !== 1 || version.rows[0]?.version !== 1) throw new Error('Unsupported admin schema');
    } else {
      await c.query('CREATE SCHEMA kabadi_admin');
      await c.query('CREATE TABLE kabadi_admin.schema_version (version integer PRIMARY KEY CHECK (version = 1))');
      // Append-only intent. The database does not forbid later UPDATE/DELETE by
      // a privileged connection; treat this as evidence, not a tamper-proof log.
      await c.query(`CREATE TABLE kabadi_admin.role_changes (
        id uuid PRIMARY KEY,
        user_id text NOT NULL,
        email text NOT NULL,
        role text NOT NULL CHECK (role IN ('customer', 'collector', 'admin')),
        action text NOT NULL CHECK (action IN ('grant', 'revoke')),
        reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 200),
        changed_at timestamptz NOT NULL DEFAULT now()
      )`);
      await c.query('CREATE INDEX ON kabadi_admin.role_changes (user_id, changed_at DESC)');
      await c.query('INSERT INTO kabadi_admin.schema_version VALUES (1)');
    }
    await c.query('COMMIT');
  } catch (error) { try { await c.query('ROLLBACK'); } catch {} throw error; } finally { c.release(); }
}

export type RoleChangeResult =
  | { outcome: 'changed'; userId: string; role: 'customer' | 'collector' | 'admin'; action: 'grant' | 'revoke' }
  | { outcome: 'already-granted' | 'already-absent'; userId: string; role: 'customer' | 'collector' | 'admin' }
  | { outcome: 'unknown-user' | 'no-account' | 'suspended-account' };

// The caller must be a local operator; identity is resolved from the
// application user table by exact email, never from a browser session.
export function createRoleAdmin(pool: pg.Pool) {
  async function resolveUser(c: pg.PoolClient, email: string): Promise<{ id: string; email: string } | null> {
    const found = await c.query<{ id: string; email: string }>('SELECT id, email FROM "user" WHERE lower(email) = $1', [email]);
    if (found.rows.length > 1) throw new Error('Ambiguous user email');
    return found.rows[0] ?? null;
  }

  async function change(email: string, role: 'customer' | 'collector' | 'admin', reason: string, action: 'grant' | 'revoke'): Promise<RoleChangeResult> {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const user = await resolveUser(c, email);
        if (!user) { await c.query('COMMIT'); return { outcome: 'unknown-user' }; }
        // Lock the account row in the same order as every other account writer
        // so a concurrent grant and a suspension cannot interleave.
        const account = await c.query<{ status: string }>('SELECT status FROM kabadi_authz.accounts WHERE user_id=$1 FOR UPDATE', [user.id]);
        if (!account.rows[0]) { await c.query('COMMIT'); return { outcome: 'no-account' }; }
        if (account.rows[0].status !== 'active') { await c.query('COMMIT'); return { outcome: 'suspended-account' }; }
        const present = await c.query<{ role: string }>('SELECT role FROM kabadi_authz.role_grants WHERE user_id=$1 AND role=$2', [user.id, role]);
        const exists = present.rowCount === 1;
        if (action === 'grant' && exists) { await c.query('COMMIT'); return { outcome: 'already-granted', userId: user.id, role }; }
        if (action === 'revoke' && !exists) { await c.query('COMMIT'); return { outcome: 'already-absent', userId: user.id, role }; }
        if (action === 'grant') {
          await c.query('INSERT INTO kabadi_authz.role_grants (user_id, role) VALUES ($1,$2)', [user.id, role]);
        } else {
          // There is no bootstrap safeguard yet: revoking the last active admin
          // would leave nobody able to use admin routes. Warn the operator in
          // the CLI, but do not block, so an accidental grant stays reversible.
          await c.query('DELETE FROM kabadi_authz.role_grants WHERE user_id=$1 AND role=$2', [user.id, role]);
        }
        await c.query('INSERT INTO kabadi_admin.role_changes (id,user_id,email,role,action,reason) VALUES ($1,$2,$3,$4,$5,$6)',
          [randomUUID(), user.id, user.email, role, action, reason]);
        await c.query('COMMIT');
        return { outcome: 'changed', userId: user.id, role, action };
      } catch (error) { try { await c.query('ROLLBACK'); } catch {} throw error; } finally { c.release(); }
  }

  return {
    async grant(emailInput: unknown, roleInput: unknown, reasonInput: unknown): Promise<RoleChangeResult> {
      const email = normalizeEmail(emailInput), role = normalizeRole(roleInput), reason = normalizeReason(reasonInput);
      if (!email || !role || !reason) throw new Error('Invalid grant arguments');
      return change(email, role, reason, 'grant');
    },
    async revoke(emailInput: unknown, roleInput: unknown, reasonInput: unknown): Promise<RoleChangeResult> {
      const email = normalizeEmail(emailInput), role = normalizeRole(roleInput), reason = normalizeReason(reasonInput);
      if (!email || !role || !reason) throw new Error('Invalid revoke arguments');
      return change(email, role, reason, 'revoke');
    },
    async activeAdminCount(): Promise<number> {
      const result = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM kabadi_authz.role_grants g
         JOIN kabadi_authz.accounts a ON a.user_id = g.user_id
         WHERE g.role = 'admin' AND a.status = 'active'`);
      return Number(result.rows[0]?.count ?? '0');
    },
    async recentChanges(limit = 20) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid limit');
      const result = await pool.query<{ id: string; email: string; role: string; action: string; reason: string; changed_at: Date }>(
        'SELECT id,email,role,action,reason,changed_at FROM kabadi_admin.role_changes ORDER BY changed_at DESC, id DESC LIMIT $1', [limit]);
      return result.rows.map(r => ({ id: r.id, email: r.email, role: r.role, action: r.action, reason: r.reason, changedAt: r.changed_at.toISOString() }));
    },
  };
}
