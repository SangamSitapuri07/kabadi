import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { CustomerDetails } from './customer-details.js';
import { calculateEstimate } from './catalog.js';

// Test-only request capture. Not an operational pickup, dispatch or settlement
// contract; no collector, scheduling, cancellation or payment exists.
//
// A request now names a real catalog category. The applicable rate is selected
// on the server at request time inside the write transaction and copied onto the
// request, so later catalog changes cannot rewrite a past estimate. Per-item
// rounding follows the owner-approved rule: nearest paise, exact ties up.
export type PickupInput = { requestKey: string; categoryId: string; estimatedGrams: number };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_GRAMS = 10_000_000;

export type PickupEstimate = {
  categoryId: string;
  categoryName: string;
  rateId: string;
  paisePerKg: number;
  amountPaise: string;
};
// Legacy free-text requests created before schema v2 keep their material and
// have no estimate. They are listed so history is not silently dropped.
export type Pickup = {
  id: string;
  status: 'requested';
  createdAt: string;
  address: CustomerDetails;
  estimatedGrams: number;
  material: string | null;
  categoryId: string | null;
  categoryName: string | null;
  rateId: string | null;
  paisePerKg: number | null;
  amountPaise: string | null;
};
export type CreatePickupResult =
  | { outcome: 'created'; estimate: PickupEstimate }
  | { outcome: 'replayed'; estimate: PickupEstimate }
  | { outcome: 'conflict' | 'missing-profile' | 'no-rate' | 'unknown-category' };

export function parsePickup(input: unknown): PickupInput | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>;
  if (Object.keys(v).length !== 3 ||
      typeof v.requestKey !== 'string' || !UUID_V4.test(v.requestKey) ||
      typeof v.categoryId !== 'string' || !UUID_V4.test(v.categoryId) ||
      !Number.isInteger(v.estimatedGrams) || (v.estimatedGrams as number) < 1 || (v.estimatedGrams as number) > MAX_GRAMS) return null;
  return { requestKey: v.requestKey.toLowerCase(), categoryId: v.categoryId.toLowerCase(), estimatedGrams: v.estimatedGrams as number };
}

// Version 2 adds the pricing snapshot. Version 1 databases are upgraded in
// place, keeping existing free-text requests valid. Never run at startup.
export async function migratePickups(pool: pg.Pool) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock($1, $2)', [1262572353, 3]);
    // The catalog is now a hard prerequisite because the snapshot columns
    // reference its rows.
    for (const schema of ['kabadi_authz', 'kabadi_customer', 'kabadi_catalog']) {
      const marker = await c.query<{ marker: string | null }>(`SELECT to_regclass('${schema}.schema_version')::text AS marker`);
      if (!marker.rows[0]?.marker) throw Error('Prerequisite schema missing');
      const versions = await c.query<{ version: number }>(`SELECT version FROM ${schema}.schema_version`);
      if (versions.rows.length !== 1 || versions.rows[0]?.version !== 1) throw Error('Unsupported schema');
    }
    const existing = await c.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='kabadi_pickup') AS exists");
    let currentVersion = 0;
    if (existing.rows[0]?.exists) {
      const marker = await c.query<{ marker: string | null }>("SELECT to_regclass('kabadi_pickup.schema_version')::text AS marker");
      if (!marker.rows[0]?.marker) throw Error('Unrecognized pickup schema');
      const versions = await c.query<{ version: number }>('SELECT version FROM kabadi_pickup.schema_version');
      if (versions.rows.length !== 1 || ![1, 2].includes(versions.rows[0]?.version as number)) throw Error('Unsupported schema');
      currentVersion = versions.rows[0]!.version;
    }
    if (currentVersion === 0) {
      await c.query('CREATE SCHEMA kabadi_pickup');
      await c.query('CREATE TABLE kabadi_pickup.schema_version (version integer PRIMARY KEY CHECK (version = 2))');
      await c.query(`CREATE TABLE kabadi_pickup.requests (
        id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES kabadi_authz.accounts(user_id) ON DELETE RESTRICT,
        request_key uuid NOT NULL, material text CHECK (material IS NULL OR char_length(material) BETWEEN 1 AND 100),
        category_id uuid REFERENCES kabadi_catalog.categories(id) ON DELETE RESTRICT,
        category_name text, rate_id uuid REFERENCES kabadi_catalog.rates(id) ON DELETE RESTRICT,
        paise_per_kg integer CHECK (paise_per_kg BETWEEN 0 AND 1000000000),
        amount_paise bigint CHECK (amount_paise >= 0),
        estimated_grams integer NOT NULL CHECK (estimated_grams BETWEEN 1 AND 10000000),
        status text NOT NULL DEFAULT 'requested' CHECK (status = 'requested'),
        name text NOT NULL, address_line text NOT NULL, city text NOT NULL, state text NOT NULL, postal_code text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, request_key),
        CONSTRAINT pickup_item_shape CHECK (
          (category_id IS NULL AND category_name IS NULL AND rate_id IS NULL AND paise_per_kg IS NULL AND amount_paise IS NULL AND material IS NOT NULL)
          OR (category_id IS NOT NULL AND category_name IS NOT NULL AND rate_id IS NOT NULL AND paise_per_kg IS NOT NULL AND amount_paise IS NOT NULL AND material IS NULL)
        )
      )`);
      await c.query('CREATE INDEX ON kabadi_pickup.requests (user_id, created_at DESC, id DESC)');
      await c.query('INSERT INTO kabadi_pickup.schema_version VALUES (2)');
    } else if (currentVersion === 1) {
      // Upgrade in place: existing rows keep material and gain no estimate.
      await c.query('ALTER TABLE kabadi_pickup.requests ALTER COLUMN material DROP NOT NULL');
      await c.query(`ALTER TABLE kabadi_pickup.requests
        ADD COLUMN category_id uuid REFERENCES kabadi_catalog.categories(id) ON DELETE RESTRICT,
        ADD COLUMN category_name text,
        ADD COLUMN rate_id uuid REFERENCES kabadi_catalog.rates(id) ON DELETE RESTRICT,
        ADD COLUMN paise_per_kg integer CHECK (paise_per_kg BETWEEN 0 AND 1000000000),
        ADD COLUMN amount_paise bigint CHECK (amount_paise >= 0)`);
      await c.query(`ALTER TABLE kabadi_pickup.requests ADD CONSTRAINT pickup_item_shape CHECK (
          (category_id IS NULL AND category_name IS NULL AND rate_id IS NULL AND paise_per_kg IS NULL AND amount_paise IS NULL AND material IS NOT NULL)
          OR (category_id IS NOT NULL AND category_name IS NOT NULL AND rate_id IS NOT NULL AND paise_per_kg IS NOT NULL AND amount_paise IS NOT NULL AND material IS NULL)
        )`);
      await c.query('ALTER TABLE kabadi_pickup.schema_version DROP CONSTRAINT IF EXISTS schema_version_version_check');
      await c.query('UPDATE kabadi_pickup.schema_version SET version = 2');
      await c.query('ALTER TABLE kabadi_pickup.schema_version ADD CONSTRAINT schema_version_version_check CHECK (version = 2)');
    }
    await c.query('COMMIT');
  } catch (error) { try { await c.query('ROLLBACK'); } catch {} throw error; } finally { c.release(); }
}

type StoredPickup = { category_id: string | null; estimated_grams: number; category_name: string | null; rate_id: string | null; paise_per_kg: number | null; amount_paise: string | null };

const row = (r: { id: string; status: 'requested'; created_at: Date; name: string; address_line: string; city: string; state: string; postal_code: string; estimated_grams: number; material: string | null; category_id: string | null; category_name: string | null; rate_id: string | null; paise_per_kg: number | null; amount_paise: string | null }): Pickup => ({
  id: r.id, status: r.status, createdAt: r.created_at.toISOString(),
  address: { name: r.name, addressLine: r.address_line, city: r.city, state: r.state, postalCode: r.postal_code },
  estimatedGrams: r.estimated_grams, material: r.material,
  categoryId: r.category_id, categoryName: r.category_name, rateId: r.rate_id,
  paisePerKg: r.paise_per_kg, amountPaise: r.amount_paise,
});

export function createPickupStore(pool: pg.Pool) {
  async function execute<T>(userId: string, action: (c: pg.PoolClient) => Promise<T>): Promise<T | 'forbidden'> {
    if (typeof userId !== 'string' || !userId.trim()) throw Error('Invalid identity');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const account = await c.query<{status: string}>('SELECT status FROM kabadi_authz.accounts WHERE user_id=$1 FOR UPDATE', [userId]);
      if (account.rows[0]?.status !== 'active') { await c.query('COMMIT'); return 'forbidden'; }
      const grant = await c.query("SELECT 1 FROM kabadi_authz.role_grants WHERE user_id=$1 AND role='customer' FOR SHARE", [userId]);
      if (grant.rowCount !== 1) { await c.query('COMMIT'); return 'forbidden'; }
      const result = await action(c); await c.query('COMMIT'); return result;
    } catch (error) { try { await c.query('ROLLBACK'); } catch {} throw error; } finally { c.release(); }
  }
  return {
    create(userId: string, raw: unknown): Promise<CreatePickupResult | 'forbidden'> {
      const input = parsePickup(raw); if (!input) throw Error('Invalid request');
      return execute(userId, async c => {
        const previous = await c.query<StoredPickup>(
          `SELECT category_id, estimated_grams, category_name, rate_id, paise_per_kg, amount_paise::text AS amount_paise
           FROM kabadi_pickup.requests WHERE user_id=$1 AND request_key=$2`, [userId, input.requestKey]);
        const prior = previous.rows[0];
        if (prior) {
          // Only an identical request replays; a legacy row or different item
          // is a conflict so the client cannot silently reuse a key.
          if (prior.category_id !== input.categoryId || prior.estimated_grams !== input.estimatedGrams ||
              prior.amount_paise === null || prior.category_name === null || prior.rate_id === null || prior.paise_per_kg === null) return { outcome: 'conflict' as const };
          return { outcome: 'replayed' as const, estimate: {
            categoryId: prior.category_id, categoryName: prior.category_name, rateId: prior.rate_id,
            paisePerKg: prior.paise_per_kg, amountPaise: prior.amount_paise,
          } };
        }
        const profile = await c.query('SELECT 1 FROM kabadi_customer.details WHERE user_id=$1', [userId]);
        if (profile.rowCount !== 1) return { outcome: 'missing-profile' as const };
        const category = await c.query<{ name: string }>('SELECT name FROM kabadi_catalog.categories WHERE id=$1 AND active', [input.categoryId]);
        if (!category.rows[0]) return { outcome: 'unknown-category' as const };
        // Request-time selection: the newest rate already effective when this
        // statement runs. The timestamp is chosen by the server, never supplied
        // by the client, and the chosen rate is snapshotted below.
        const rate = await c.query<{ id: string; paise_per_kg: number }>(
          `SELECT id, paise_per_kg FROM kabadi_catalog.rates
           WHERE category_id=$1 AND effective_from <= clock_timestamp()
           ORDER BY effective_from DESC LIMIT 1`, [input.categoryId]);
        const chosen = rate.rows[0];
        if (!chosen) return { outcome: 'no-rate' as const };
        const estimate = calculateEstimate(input.estimatedGrams, chosen.paise_per_kg);
        if (!estimate) throw Error('Invalid estimate');
        // ON CONFLICT keeps a concurrent retry from aborting the transaction:
        // if another connection inserted this key first, nothing is written here
        // and the committed row is read back below.
        const inserted = await c.query(
          `INSERT INTO kabadi_pickup.requests (id,user_id,request_key,category_id,category_name,rate_id,paise_per_kg,amount_paise,estimated_grams,name,address_line,city,state,postal_code)
           SELECT $1,$2,$3,$4,$5,$6,$7,$8::bigint,$9,name,address_line,city,state,postal_code
           FROM kabadi_customer.details WHERE user_id=$2
           ON CONFLICT (user_id, request_key) DO NOTHING RETURNING id`,
          [randomUUID(), userId, input.requestKey, input.categoryId, category.rows[0].name, chosen.id,
           chosen.paise_per_kg, estimate.amountPaise, input.estimatedGrams]);
        if (inserted.rowCount !== 1) {
          // Either the profile vanished (the SELECT matched no row) or another
          // retry won the race. DO NOTHING does not abort this transaction, and
          // READ COMMITTED re-snapshots per statement, so the committed winner
          // is visible to this re-read. Only a missing profile remains otherwise.
          const raced = await c.query<StoredPickup>(
            `SELECT category_id, estimated_grams, category_name, rate_id, paise_per_kg, amount_paise::text AS amount_paise
             FROM kabadi_pickup.requests WHERE user_id=$1 AND request_key=$2`, [userId, input.requestKey]);
          const prior = raced.rows[0];
          if (prior) {
            if (prior.category_id !== input.categoryId || prior.estimated_grams !== input.estimatedGrams ||
                prior.amount_paise === null || prior.category_name === null || prior.rate_id === null || prior.paise_per_kg === null) return { outcome: 'conflict' as const };
            return { outcome: 'replayed' as const, estimate: {
              categoryId: prior.category_id, categoryName: prior.category_name, rateId: prior.rate_id,
              paisePerKg: prior.paise_per_kg, amountPaise: prior.amount_paise,
            } };
          }
          return { outcome: 'missing-profile' as const };
        }
        return { outcome: 'created' as const, estimate: {
          categoryId: input.categoryId, categoryName: category.rows[0].name, rateId: chosen.id,
          paisePerKg: chosen.paise_per_kg, amountPaise: estimate.amountPaise,
        } };
      });
    },
    list(userId: string): Promise<Pickup[] | 'forbidden'> {
      return execute(userId, async c => {
        const rows = await c.query<Parameters<typeof row>[0]>(
          `SELECT id,status,created_at,name,address_line,city,state,postal_code,estimated_grams,material,
             category_id,category_name,rate_id,paise_per_kg,amount_paise::text AS amount_paise
           FROM kabadi_pickup.requests WHERE user_id=$1 ORDER BY created_at DESC, id DESC LIMIT 50`, [userId]);
        return rows.rows.map(row);
      });
    },
  };
}
