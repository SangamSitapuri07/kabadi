import pg from 'pg';
import type { Role } from './account-store.js';

// Creating a test identity means two rows, not one: the auth user (made by Better
// Auth) and the application account with its role grant. The role tool correctly
// refuses an account with no row, so a form that only made the auth user left the
// operator with an identity nobody could use -- which is exactly what happened.
//
// Both rows are written here, in one transaction, for the id Better Auth just
// created. The role is the one the operator selected, never derived from the
// email address: two test accounts could share a name.
export function createDevProvisioner(pool: pg.Pool) {
  return async function provision(userId: string, role: Role): Promise<'ready' | 'forbidden' | 'taken'> {
    if (typeof userId !== 'string' || !userId.trim()) throw new Error('Invalid user id');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      // The auth user must exist: this function may only provision an identity
      // that Better Auth has already created, never invent one.
      const user = await c.query('SELECT 1 FROM "user" WHERE id=$1', [userId]);
      if (!user.rowCount) { await c.query('COMMIT'); return 'forbidden'; }
      // Checked explicitly rather than inferred from an INSERT's row count.
      // `ON CONFLICT DO NOTHING ... RETURNING` returns no row when it skips, but
      // some drivers and emulators report a row count anyway, and this function
      // decides whether to add a role to an existing account. An ambiguous answer
      // here is the difference between "new identity" and "somebody else's
      // account", so it is asked as a question with one possible answer.
      const existing = await c.query('SELECT 1 FROM kabadi_authz.accounts WHERE user_id=$1', [userId]);
      if (existing.rowCount) {
        // The account already existed, so this id is not fresh. Refusing is what
        // stops the form being used to add a tier to somebody else's account.
        await c.query('COMMIT');
        return 'taken';
      }
      await c.query("INSERT INTO kabadi_authz.accounts (user_id, status) VALUES ($1,'active')", [userId]);
      await c.query('INSERT INTO kabadi_authz.role_grants (user_id, role) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, role]);
      await c.query('COMMIT');
      return 'ready';
    } catch (error) {
      try { await c.query('ROLLBACK'); } catch { /* preserve original failure */ }
      throw error;
    } finally { c.release(); }
  };
}
