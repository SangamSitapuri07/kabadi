import pg from 'pg';
import { createAuthRuntime, readAuthConfig } from './auth.js';

// Separate schema, separate migration, deliberately: the lots chain is a
// different concern from pickups and has its own version. Nothing here runs at
// startup, and nothing here touches an existing schema's data.
export const LOT_SCHEMA_VERSION = 1;

if (process.env.LOTS_MIGRATION_CONFIRM !== 'yes') {
  console.error('Set LOTS_MIGRATION_CONFIRM=yes only for a disposable development database.');
  process.exit(1);
}

let auth: ReturnType<typeof createAuthRuntime> | undefined;
let pool: pg.Pool | undefined;
try {
  const config = readAuthConfig(process.env);
  if (!config) throw new Error('Auth is disabled.');
  auth = createAuthRuntime(config);
  const status = await auth.schemaStatus();
  if (status.missing || status.problems) throw new Error('Authentication schema is not ready.');
  pool = new pg.Pool({ connectionString: config.databaseURL, max: 1, connectionTimeoutMillis: 5000 });
  pool.on('error', () => console.error('An idle lot database connection failed.'));
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock($1, $2)', [1262572353, 5]);
    const existing = await c.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='kabadi_lots') AS exists");
    if (existing.rows[0]?.exists) {
      const marker = await c.query<{ marker: string | null }>("SELECT to_regclass('kabadi_lots.schema_version')::text AS marker");
      if (!marker.rows[0]?.marker) throw new Error('Unrecognized lot schema');
      const versions = await c.query<{ version: number }>('SELECT version FROM kabadi_lots.schema_version');
      if (versions.rows.length !== 1 || versions.rows[0]?.version !== LOT_SCHEMA_VERSION) throw new Error('Unsupported lot schema version');
      console.log('Lot schema is already version 1; nothing changed.');
    } else {
      await c.query('CREATE SCHEMA kabadi_lots');
      await c.query(`CREATE TABLE kabadi_lots.schema_version (version integer PRIMARY KEY CHECK (version = ${LOT_SCHEMA_VERSION}))`);
      await c.query(`CREATE TABLE kabadi_lots.lots (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        -- Who is holding this material right now. Never updated: custody moves
        -- by closing this row and opening a new one at the buyer.
        holder_id text NOT NULL REFERENCES kabadi_authz.accounts(user_id) ON DELETE RESTRICT,
        material text NOT NULL CHECK (char_length(material) BETWEEN 1 AND 100),
        grams integer NOT NULL CHECK (grams BETWEEN 1 AND 10000000),
        -- What the current holder paid for this material.
        cost_paise bigint NOT NULL CHECK (cost_paise >= 0),
        status text NOT NULL DEFAULT 'held' CHECK (status IN ('held','sold')),
        -- Set when the lot was opened from a collected pickup. UNIQUE is the
        -- database-level guarantee that one pickup becomes one lot, so a double
        -- click cannot duplicate the platform's stock.
        source_pickup_id uuid UNIQUE REFERENCES kabadi_pickup.requests(id) ON DELETE RESTRICT,
        -- Set when the lot was opened by a sale. A lot has at most one of these
        -- two origins, and a fresh lot must have neither.
        parent_lot_id uuid REFERENCES kabadi_lots.lots(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        sold_at timestamptz,
        CONSTRAINT lot_origin CHECK (source_pickup_id IS NULL OR parent_lot_id IS NULL),
        -- A sold lot has a time; a held one does not. Without this a row can
        -- claim to be sold and carry no evidence of when.
        CONSTRAINT lot_status_shape CHECK (
          (status='held' AND sold_at IS NULL) OR (status='sold' AND sold_at IS NOT NULL)
        )
      )`);
      await c.query('CREATE INDEX lot_holder ON kabadi_lots.lots (holder_id, status, created_at)');
      await c.query('CREATE INDEX lot_parent ON kabadi_lots.lots (parent_lot_id)');
      await c.query(`CREATE TABLE kabadi_lots.sales (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        -- One sale per lot: a lot that has been sold cannot be sold again, and
        -- the primary key here turns a racing second sale into a constraint
        -- violation rather than a second payment.
        lot_id uuid NOT NULL UNIQUE REFERENCES kabadi_lots.lots(id) ON DELETE RESTRICT,
        seller_id text NOT NULL REFERENCES kabadi_authz.accounts(user_id) ON DELETE RESTRICT,
        buyer_id text NOT NULL REFERENCES kabadi_authz.accounts(user_id) ON DELETE RESTRICT,
        grams integer NOT NULL CHECK (grams BETWEEN 1 AND 10000000),
        -- The tier the material moved up to, frozen at the sale. Grants are
        -- mutable; a history that recalculated from them would rewrite itself.
        buyer_tier text CHECK (buyer_tier IN ('customer','collector','shop','mandi','recycler')),
        price_paise bigint NOT NULL CHECK (price_paise >= 0),
        -- The lot opened at the buyer. Null only for a terminal recycler.
        buyer_lot_id uuid REFERENCES kabadi_lots.lots(id) ON DELETE RESTRICT,
        recorded_at timestamptz NOT NULL DEFAULT now(),
        -- Nobody sells to themselves, at the database layer as well as in code.
        CONSTRAINT sale_distinct_parties CHECK (seller_id <> buyer_id)
      )`);
      await c.query('CREATE INDEX sale_seller ON kabadi_lots.sales (seller_id, recorded_at DESC)');
      await c.query('CREATE INDEX sale_buyer ON kabadi_lots.sales (buyer_id, recorded_at DESC)');
      await c.query(`INSERT INTO kabadi_lots.schema_version VALUES (${LOT_SCHEMA_VERSION})`);
      await c.query('COMMIT');
      console.log('Lot schema created at version 1: lots, sales, and the custody chain they describe.');
    }
  } catch (error) { try { await c.query('ROLLBACK'); } catch {} throw error; } finally { c.release(); }
} catch {
  console.error('Lot migration failed; check the development configuration and that the pickup and authorization schemas exist.');
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
  if (auth) await auth.close();
}
