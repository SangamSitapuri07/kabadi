import type pg from 'pg';

// Development-only draft: one editable pickup address per customer.
// These limits are technical bounds, not final policy.
export type CustomerDetails = Readonly<{
  name: string;
  addressLine: string;
  city: string;
  state: string;
  postalCode: string;
}>;
const limits = { name: 100, addressLine: 200, city: 100, state: 100, postalCode: 20 } as const;

export function parseCustomerDetails(input: unknown): CustomerDetails | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const keys = Object.keys(limits) as (keyof typeof limits)[];
  if (Object.keys(record).length !== keys.length || !keys.every(key => Object.hasOwn(record, key))) return null;
  const output = {} as Record<keyof typeof limits, string>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string' || /[\uD800-\uDFFF]/u.test(value)) return null;
    const trimmed = value.trim();
    // Reject embedded control characters, including NUL, not normal Unicode text.
    if (!trimmed || Array.from(trimmed).length > limits[key] || /[\u0000-\u001f\u007f-\u009f]/u.test(trimmed)) return null;
    output[key] = trimmed;
  }
  return output;
}

// Separate, explicit development schema; never called by server startup.
export async function migrateCustomerDetails(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [1262572353, 2]);
    const authzMarker = await client.query<{ marker: string | null }>("SELECT to_regclass('kabadi_authz.schema_version')::text AS marker");
    if (!authzMarker.rows[0]?.marker) throw new Error('Authorization schema is not ready');
    const authzVersions = await client.query<{ version: number }>('SELECT version FROM kabadi_authz.schema_version');
    if (authzVersions.rows.length !== 1 || authzVersions.rows[0]?.version !== 1) throw new Error('Unsupported authorization schema');
    const existing = await client.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'kabadi_customer') AS exists");
    if (existing.rows[0]?.exists) {
      const marker = await client.query<{ marker: string | null }>("SELECT to_regclass('kabadi_customer.schema_version')::text AS marker");
      if (!marker.rows[0]?.marker) throw new Error('Unrecognized customer schema');
      const versions = await client.query<{ version: number }>('SELECT version FROM kabadi_customer.schema_version');
      if (versions.rows.length !== 1 || versions.rows[0]?.version !== 1) throw new Error('Unsupported customer schema');
    } else {
      await client.query('CREATE SCHEMA kabadi_customer');
      await client.query('CREATE TABLE kabadi_customer.schema_version (version integer PRIMARY KEY CHECK (version = 1))');
      await client.query(`CREATE TABLE kabadi_customer.details (
        user_id text PRIMARY KEY REFERENCES kabadi_authz.accounts(user_id) ON DELETE CASCADE,
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
        address_line text NOT NULL CHECK (char_length(address_line) BETWEEN 1 AND 200),
        city text NOT NULL CHECK (char_length(city) BETWEEN 1 AND 100),
        state text NOT NULL CHECK (char_length(state) BETWEEN 1 AND 100),
        postal_code text NOT NULL CHECK (char_length(postal_code) BETWEEN 1 AND 20),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      await client.query('INSERT INTO kabadi_customer.schema_version VALUES (1)');
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve failure */ }
    throw error;
  } finally { client.release(); }
}

// userId MUST come from a validated server-side session, never request input.
// Each operation verifies active status and customer grant in the same transaction.
// Future status/grant writers must lock the account row first as well.
export function createCustomerDetailsStore(pool: pg.Pool) {
  async function execute<T>(userId: string, action: (client: pg.PoolClient) => Promise<T>): Promise<T | 'forbidden'> {
    if (typeof userId !== 'string' || !userId.trim()) throw new Error('Invalid identity');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const account = await client.query<{ status: string }>('SELECT status FROM kabadi_authz.accounts WHERE user_id = $1 FOR UPDATE', [userId]);
      if (account.rows[0]?.status !== 'active') { await client.query('COMMIT'); return 'forbidden'; }
      const grant = await client.query("SELECT 1 FROM kabadi_authz.role_grants WHERE user_id = $1 AND role = 'customer' FOR SHARE", [userId]);
      if (grant.rowCount !== 1) { await client.query('COMMIT'); return 'forbidden'; }
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve failure */ }
      throw error;
    } finally { client.release(); }
  }
  return {
    read(userId: string): Promise<CustomerDetails | null | 'forbidden'> {
      return execute(userId, async client => {
        const result = await client.query<CustomerDetails>(`SELECT name, address_line AS "addressLine", city, state, postal_code AS "postalCode"
          FROM kabadi_customer.details WHERE user_id = $1`, [userId]);
        return result.rows[0] ?? null;
      });
    },
    write(userId: string, input: unknown): Promise<'saved' | 'forbidden'> {
      const details = parseCustomerDetails(input);
      if (!details) throw new Error('Invalid customer details');
      return execute(userId, async client => {
        await client.query(`INSERT INTO kabadi_customer.details (user_id, name, address_line, city, state, postal_code)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name, address_line = EXCLUDED.address_line,
          city = EXCLUDED.city, state = EXCLUDED.state, postal_code = EXCLUDED.postal_code, updated_at = now()`,
        [userId, details.name, details.addressLine, details.city, details.state, details.postalCode]);
        return 'saved' as const;
      });
    },
  };
}
