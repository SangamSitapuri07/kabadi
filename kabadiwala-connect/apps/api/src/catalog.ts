import pg from 'pg';
import { randomUUID } from 'node:crypto';

// Development foundation. Callers of writes MUST derive actorId from a
// validated server session, never a browser claim.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_GRAMS = 10_000_000;
export const MAX_RATE_PAISE_PER_KG = 1_000_000_000;
export function categoryName(input: unknown): string | null {
  if (typeof input !== 'string' || /[\uD800-\uDFFF\u0000-\u001f\u007f-\u009f]/u.test(input)) return null;
  const value = input.trim();
  return value && Array.from(value).length <= 100 ? value : null;
}
export function utcTimestamp(input: unknown): string | null {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)) return null;
  const date = new Date(input);
  return Number.isFinite(date.getTime()) && date.toISOString() === input ? input : null;
}
export function rateValue(input: unknown): number | null {
  return typeof input === 'number' && Number.isInteger(input) && input >= 0 && input <= MAX_RATE_PAISE_PER_KG ? input : null;
}
// Round each nonnegative item to the nearest paise, with exact ties up.
// Decimal strings prevent precision loss even when a product exceeds 2^53.
export function calculateEstimate(grams: unknown, paisePerKg: unknown): { amountPaise: string } | null {
  if (typeof grams !== 'number' || !Number.isInteger(grams) || grams < 1 || grams > MAX_GRAMS || rateValue(paisePerKg) === null) return null;
  const product = BigInt(grams) * BigInt(paisePerKg as number);
  const whole = product / 1000n, remainder = product % 1000n;
  return { amountPaise: (whole + (remainder >= 500n ? 1n : 0n)).toString() };
}

export async function migrateCatalog(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [1262572353, 4]);
    const marker = await client.query<{marker: string | null}>("SELECT to_regclass('kabadi_authz.schema_version')::text AS marker");
    if (!marker.rows[0]?.marker) throw Error('Authorization schema missing');
    const versions = await client.query<{version: number}>('SELECT version FROM kabadi_authz.schema_version');
    if (versions.rows.length !== 1 || versions.rows[0]?.version !== 1) throw Error('Unsupported authorization schema');
    const existing = await client.query<{exists: boolean}>("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='kabadi_catalog') AS exists");
    if (existing.rows[0]?.exists) {
      const present = await client.query<{marker: string | null}>("SELECT to_regclass('kabadi_catalog.schema_version')::text AS marker");
      if (!present.rows[0]?.marker) throw Error('Unrecognized catalog schema');
      const version = await client.query<{version: number}>('SELECT version FROM kabadi_catalog.schema_version');
      if (version.rows.length !== 1 || version.rows[0]?.version !== 1) throw Error('Unsupported catalog schema');
    } else {
      await client.query('CREATE SCHEMA kabadi_catalog');
      await client.query('CREATE TABLE kabadi_catalog.schema_version (version integer PRIMARY KEY CHECK (version = 1))');
      await client.query(`CREATE TABLE kabadi_catalog.categories (
        id uuid PRIMARY KEY, name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
        active boolean NOT NULL DEFAULT true, created_by text NOT NULL REFERENCES kabadi_authz.accounts(user_id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
      await client.query('CREATE UNIQUE INDEX catalog_category_name ON kabadi_catalog.categories (lower(name))');
      // Each event takes effect until the next event, so intervals cannot overlap.
      // Unique starts protect the boundary; all writers must take the category lock
      // to enforce strictly increasing insert order and future-only policy.
      await client.query(`CREATE TABLE kabadi_catalog.rates (
        id uuid PRIMARY KEY, category_id uuid NOT NULL REFERENCES kabadi_catalog.categories(id) ON DELETE RESTRICT,
        effective_from timestamptz NOT NULL, paise_per_kg integer NOT NULL CHECK (paise_per_kg BETWEEN 0 AND 1000000000),
        created_by text NOT NULL REFERENCES kabadi_authz.accounts(user_id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (category_id, effective_from)
      )`);
      await client.query('INSERT INTO kabadi_catalog.schema_version VALUES (1)');
    }
    await client.query('COMMIT');
  } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
}

export function createCatalogStore(pool: pg.Pool) {
  async function adminWrite<T>(actorId: string, action: (c: pg.PoolClient) => Promise<T>): Promise<T | 'forbidden'> {
    if (typeof actorId !== 'string' || !actorId.trim()) throw Error('Invalid identity');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const account = await c.query<{status:string}>('SELECT status FROM kabadi_authz.accounts WHERE user_id=$1 FOR UPDATE', [actorId]);
      if (account.rows[0]?.status !== 'active') { await c.query('COMMIT'); return 'forbidden'; }
      const grant = await c.query("SELECT 1 FROM kabadi_authz.role_grants WHERE user_id=$1 AND role='admin' FOR SHARE", [actorId]);
      if (grant.rowCount !== 1) { await c.query('COMMIT'); return 'forbidden'; }
      const result = await action(c); await c.query('COMMIT'); return result;
    } catch (error) { try { await c.query('ROLLBACK'); } catch {} throw error; } finally { c.release(); }
  }
  return {
    createCategory(actorId: string, rawName: unknown): Promise<{id:string} | 'duplicate' | 'forbidden'> {
      const name = categoryName(rawName); if (!name) throw Error('Invalid category');
      return adminWrite(actorId, async c => {
        const id = randomUUID();
        const result = await c.query('INSERT INTO kabadi_catalog.categories (id,name,created_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id', [id,name,actorId]);
        return result.rowCount === 1 ? {id} : 'duplicate' as const;
      });
    },
    addRate(actorId: string, categoryId: string, effectiveFrom: unknown, rawRate: unknown): Promise<{id:string} | 'invalid-time' | 'not-found' | 'forbidden'> {
      const at = utcTimestamp(effectiveFrom), rate = rateValue(rawRate);
      if (typeof categoryId !== 'string' || !UUID.test(categoryId) || !at || rate === null) throw Error('Invalid rate');
      return adminWrite(actorId, async c => {
        const category = await c.query<{active:boolean}>('SELECT active FROM kabadi_catalog.categories WHERE id=$1 FOR UPDATE', [categoryId]);
        if (!category.rows[0]?.active) return 'not-found' as const;
        // A separate query after acquiring the lock sees a committed preceding
        // writer under READ COMMITTED, including writers for different admins.
        const check = await c.query<{allowed:boolean}>(`SELECT $2::timestamptz > clock_timestamp() AND
          NOT EXISTS (SELECT 1 FROM kabadi_catalog.rates WHERE category_id=$1 AND effective_from >= $2::timestamptz) AS allowed`, [categoryId,at]);
        if (!check.rows[0]?.allowed) return 'invalid-time' as const;
        const id = randomUUID();
        await c.query('INSERT INTO kabadi_catalog.rates (id,category_id,effective_from,paise_per_kg,created_by) VALUES ($1,$2,$3,$4,$5)', [id,categoryId,at,rate,actorId]);
        return {id};
      });
    },
    // Research helper only. A future request must choose its timestamp on the
    // server inside the request transaction and persist immutable rate snapshots.
    async lookupAt(categoryId: string, timestamp: unknown): Promise<{rateId:string; paisePerKg:number} | null> {
      const at = utcTimestamp(timestamp); if (typeof categoryId !== 'string' || !UUID.test(categoryId) || !at) throw Error('Invalid lookup');
      const found = await pool.query<{id:string;paise_per_kg:number}>(`SELECT r.id,r.paise_per_kg FROM kabadi_catalog.rates r
        JOIN kabadi_catalog.categories c ON c.id=r.category_id AND c.active
        WHERE r.category_id=$1 AND r.effective_from <= $2::timestamptz ORDER BY r.effective_from DESC LIMIT 1`, [categoryId,at]);
      return found.rows[0] ? {rateId:found.rows[0].id, paisePerKg:found.rows[0].paise_per_kg} : null;
    },
  };
}
