import type pg from 'pg';

// Caller must supply an ID obtained from a validated server-side session, never
// a request parameter. Only a *new* account receives the customer role; this
// must not reactivate suspended users or add roles to existing accounts.
export function createCustomerOnboarder(pool: pg.Pool) {
  return async (userId: string): Promise<'ready' | 'forbidden'> => {
    if (!userId || !userId.trim()) throw new Error('Invalid user ID');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        "INSERT INTO kabadi_authz.accounts (user_id, status) VALUES ($1, 'active') ON CONFLICT (user_id) DO NOTHING RETURNING user_id", [userId],
      );
      if (inserted.rowCount === 1) {
        await client.query("INSERT INTO kabadi_authz.role_grants (user_id, role) VALUES ($1, 'customer')", [userId]);
        await client.query('COMMIT');
        return 'ready';
      }
      const existing = await client.query<{ status: string; customer: boolean }>(
        `SELECT a.status, EXISTS (SELECT 1 FROM kabadi_authz.role_grants g
          WHERE g.user_id = a.user_id AND g.role = 'customer') AS customer
         FROM kabadi_authz.accounts a WHERE a.user_id = $1 FOR UPDATE OF a`, [userId],
      );
      const row = existing.rows[0];
      const result = row?.status === 'active' && row.customer === true ? 'ready' : 'forbidden';
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
      throw error;
    } finally { client.release(); }
  };
}
