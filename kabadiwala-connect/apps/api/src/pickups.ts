import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { CustomerDetails } from './customer-details.js';

// Test-only request capture, not an operational pickup or pricing contract.
export type PickupInput = { requestKey: string; material: string; estimatedGrams: number };
export type Pickup = { id: string; material: string; estimatedGrams: number; status: 'requested'; createdAt: string; address: CustomerDetails };
export function parsePickup(input: unknown): PickupInput | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>;
  if (Object.keys(v).length !== 3 || typeof v.requestKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.requestKey) ||
      typeof v.material !== 'string' || /[\uD800-\uDFFF\u0000-\u001f\u007f-\u009f]/u.test(v.material) || !v.material.trim() || Array.from(v.material.trim()).length > 100 ||
      !Number.isInteger(v.estimatedGrams) || (v.estimatedGrams as number) < 1 || (v.estimatedGrams as number) > 10000000) return null;
  return { requestKey: v.requestKey.toLowerCase(), material: v.material.trim(), estimatedGrams: v.estimatedGrams as number };
}
export async function migratePickups(pool: pg.Pool) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock($1, $2)', [1262572353, 3]);
    for (const schema of ['kabadi_authz', 'kabadi_customer']) {
      const marker = await c.query<{ marker: string | null }>(`SELECT to_regclass('${schema}.schema_version')::text AS marker`);
      if (!marker.rows[0]?.marker) throw Error('Prerequisite schema missing');
      const versions = await c.query<{version: number}>(`SELECT version FROM ${schema}.schema_version`);
      if (versions.rows.length !== 1 || versions.rows[0]?.version !== 1) throw Error('Unsupported schema');
    }
    const existing = await c.query<{exists: boolean}>("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='kabadi_pickup') AS exists");
    if (existing.rows[0]?.exists) {
      const marker = await c.query<{marker: string | null}>("SELECT to_regclass('kabadi_pickup.schema_version')::text AS marker");
      if (!marker.rows[0]?.marker) throw Error('Unrecognized pickup schema');
      const versions = await c.query<{version: number}>('SELECT version FROM kabadi_pickup.schema_version');
      if (versions.rows.length !== 1 || versions.rows[0]?.version !== 1) throw Error('Unsupported schema');
    } else {
      await c.query('CREATE SCHEMA kabadi_pickup');
      await c.query('CREATE TABLE kabadi_pickup.schema_version (version integer PRIMARY KEY CHECK (version = 1))');
      await c.query(`CREATE TABLE kabadi_pickup.requests (
        id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES kabadi_authz.accounts(user_id) ON DELETE RESTRICT,
        request_key uuid NOT NULL, material text NOT NULL CHECK (char_length(material) BETWEEN 1 AND 100),
        estimated_grams integer NOT NULL CHECK (estimated_grams BETWEEN 1 AND 10000000),
        status text NOT NULL DEFAULT 'requested' CHECK (status = 'requested'),
        name text NOT NULL, address_line text NOT NULL, city text NOT NULL, state text NOT NULL, postal_code text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, request_key)
      )`);
      await c.query('CREATE INDEX ON kabadi_pickup.requests (user_id, created_at DESC, id DESC)');
      await c.query('INSERT INTO kabadi_pickup.schema_version VALUES (1)');
    }
    await c.query('COMMIT');
  } catch (error) { try { await c.query('ROLLBACK'); } catch {} throw error; } finally { c.release(); }
}
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
    create(userId: string, raw: unknown): Promise<'created' | 'missing-profile' | 'conflict' | 'forbidden'> {
      const input = parsePickup(raw); if (!input) throw Error('Invalid request');
      return execute(userId, async c => {
        const previous = await c.query<{material:string; estimated_grams:number}>('SELECT material, estimated_grams FROM kabadi_pickup.requests WHERE user_id=$1 AND request_key=$2', [userId, input.requestKey]);
        if (previous.rows[0]) return previous.rows[0].material === input.material && previous.rows[0].estimated_grams === input.estimatedGrams ? 'created' as const : 'conflict' as const;
        const inserted = await c.query(`INSERT INTO kabadi_pickup.requests (id, user_id, request_key, material, estimated_grams, name, address_line, city, state, postal_code)
          SELECT $1, $2, $3, $4, $5, name, address_line, city, state, postal_code FROM kabadi_customer.details WHERE user_id=$2`,
          [randomUUID(), userId, input.requestKey, input.material, input.estimatedGrams]);
        return inserted.rowCount === 1 ? 'created' as const : 'missing-profile' as const;
      });
    },
    list(userId: string): Promise<Pickup[] | 'forbidden'> {
      return execute(userId, async c => {
        const rows = await c.query<{id:string;material:string;estimated_grams:number;status:'requested';created_at:Date;name:string;address_line:string;city:string;state:string;postal_code:string}>(
          'SELECT id, material, estimated_grams, status, created_at, name, address_line, city, state, postal_code FROM kabadi_pickup.requests WHERE user_id=$1 ORDER BY created_at DESC, id DESC LIMIT 50', [userId]);
        return rows.rows.map(r => ({ id:r.id, material:r.material, estimatedGrams:r.estimated_grams, status:r.status, createdAt:r.created_at.toISOString(), address:{name:r.name,addressLine:r.address_line,city:r.city,state:r.state,postalCode:r.postal_code} }));
      });
    },
  };
}
