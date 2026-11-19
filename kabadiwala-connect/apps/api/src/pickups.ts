import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { CustomerDetails } from './customer-details.js';
import { calculateEstimate } from './catalog.js';

// Development request capture and collection. A collector can accept a request,
// record the measured weight, and that fixes the final amount at the rate in
// force at collection. Still not operational: no scheduling, cancellation,
// reassignment, dispute handling, payment or retention policy exists.

// PAYMENT MECHANISM IS DELIBERATELY UNDECIDED.
//
// A payout row records that money changed hands; it does not cause money to
// move. Which rail is used (bank transfer, UPI, cash on pickup, a provider
// integration) is an open product decision, so this module contains no
// provider client, no credentials, no webhook and no transfer code. When the
// mechanism is chosen, a provider layer plugs in behind `recordPayout`; the
// ledger, the amount sourcing and the once-only guard stay exactly as they are.
//
// The values below are the set the NOT NULL CHECK on kabadi_pickup.payouts.method
// accepts. Adding one is a schema migration, not just a code change.
export const PAYOUT_METHODS = ['cash', 'transfer', 'adjustment'] as const;
export type PayoutMethod = typeof PAYOUT_METHODS[number];
export const isPayoutMethod = (value: unknown): value is PayoutMethod =>
  typeof value === 'string' && (PAYOUT_METHODS as readonly string[]).includes(value);

// What the application can honestly claim about moving money today: nothing.
// A UI reads this so it never implies a payment was sent.
export const PAYMENT_PROVIDER = { configured: false as const, name: null as null };
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
  status: 'requested' | 'accepted' | 'collected' | 'cancelled';
  createdAt: string;
  address: CustomerDetails;
  estimatedGrams: number;
  material: string | null;
  categoryId: string | null;
  categoryName: string | null;
  rateId: string | null;
  paisePerKg: number | null;
  amountPaise: string | null;
  // Filled in by a collector. Until status is 'collected' there is no final
  // amount and the estimate remains an estimate.
  actualGrams: number | null;
  finalRateId: string | null;
  finalPaisePerKg: number | null;
  finalAmountPaise: string | null;
  collectedAt: string | null;
  // Cancellation is terminal. A cancelled request keeps whatever estimate or
  // settlement it already had; nothing is erased or refunded.
  cancelledAt: string | null;
  cancellationReason: string | null;
  // Set when a collector gives the request back; the row returns to 'requested'.
  releasedAt: string | null;
  // A customer can dispute a settled amount once. The settlement stays visible
  // and unchanged until an admin resolves it, so the disputed figure is never
  // hidden from either party.
  dispute:
    | { status: 'open' | 'rejected' | 'resolved'; raisedAt: string; reason: string; resolvedAt: string | null }
    | null;
  // What the collector was actually paid, if anything. Null means unpaid; the
  // ledger is the source of truth and this is its read-only projection.
  payout: { amountPaise: string; method: PayoutMethod; paidAt: string } | null;
};
// Cancelling is the customer's own decision on their own row. A collected or
// already-cancelled request is terminal and cannot be cancelled again.
// A dispute never edits the settlement in place. An admin resolves it by
// replacing the measured weight, which re-prices at the rate frozen at
// collection time, and the previous settlement is kept in history.
// Recording a payment is an admin action. It is deliberately separate from
// collection: deciding the amount and moving the money are different acts by
// different people, and the ledger records who did the second one.
export type PayoutOutcome =
  | { outcome: 'paid'; amountPaise: string; method: string }
  | { outcome: 'not-found' | 'not-collected' | 'already-paid' | 'disputed' };

export type DisputeOutcome =
  | { outcome: 'raised' }
  | { outcome: 'rejected' }
  | { outcome: 'resolved'; finalAmountPaise: string; finalPaisePerKg: number; actualGrams: number }
  | { outcome: 'not-found' | 'not-collected' | 'already-open' | 'none-open'
      | 'same-weight' | 'not-owner' | 'not-a-collector' };

export type CancelOutcome =
  | { outcome: 'cancelled' }
  | { outcome: 'not-found' | 'already-cancelled' | 'already-collected' };

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
export type PickupMigrationReport = {
  action: 'created' | 'upgraded' | 'unchanged';
  schemaVersion: 6;
  fromVersion: number;
  // Requests created before pricing existed. They survive untouched but carry
  // no estimate, so the operator must know how many there are.
  legacyRequests: number;
};
export async function migratePickups(pool: pg.Pool): Promise<PickupMigrationReport> {
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
      if (versions.rows.length !== 1 || ![1, 2, 3, 4, 5, 6].includes(versions.rows[0]?.version as number)) throw Error('Unsupported schema');
      currentVersion = versions.rows[0]!.version;
    }
    // Remember where we started so the report can describe the real change
    // even though the migration walks the version forward.
    const startingVersion = currentVersion;
    if (currentVersion === 0) {
      await c.query('CREATE SCHEMA kabadi_pickup');
      await c.query('CREATE TABLE kabadi_pickup.schema_version (version integer PRIMARY KEY CHECK (version = 6))');
      await c.query(`CREATE TABLE kabadi_pickup.requests (
        id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES kabadi_authz.accounts(user_id) ON DELETE RESTRICT,
        request_key uuid NOT NULL, material text CHECK (material IS NULL OR char_length(material) BETWEEN 1 AND 100),
        category_id uuid REFERENCES kabadi_catalog.categories(id) ON DELETE RESTRICT,
        category_name text, rate_id uuid REFERENCES kabadi_catalog.rates(id) ON DELETE RESTRICT,
        paise_per_kg integer CHECK (paise_per_kg BETWEEN 0 AND 1000000000),
        amount_paise bigint CHECK (amount_paise >= 0),
        estimated_grams integer NOT NULL CHECK (estimated_grams BETWEEN 1 AND 10000000),
        status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','accepted','collected','cancelled')),
        collector_id text REFERENCES kabadi_authz.accounts(user_id) ON DELETE RESTRICT,
        accepted_at timestamptz,
        collected_at timestamptz,
        actual_grams integer CHECK (actual_grams BETWEEN 1 AND 10000000),
        final_rate_id uuid REFERENCES kabadi_catalog.rates(id) ON DELETE RESTRICT,
        final_paise_per_kg integer CHECK (final_paise_per_kg BETWEEN 0 AND 1000000000),
        final_amount_paise bigint CHECK (final_amount_paise >= 0),
        cancelled_at timestamptz,
        cancellation_reason text CHECK (cancellation_reason IS NULL OR char_length(cancellation_reason) BETWEEN 1 AND 200),
        released_at timestamptz,
        dispute_status text CHECK (dispute_status IS NULL OR dispute_status IN ('open','resolved','rejected')),
        dispute_reason text CHECK (dispute_reason IS NULL OR char_length(dispute_reason) BETWEEN 1 AND 200),
        dispute_raised_at timestamptz,
        dispute_resolved_at timestamptz,
        name text NOT NULL, address_line text NOT NULL, city text NOT NULL, state text NOT NULL, postal_code text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, request_key),
        -- Lifecycle and settlement must agree: an accepted request has a
        -- collector, a collected one has a measured weight and a final price.
        CONSTRAINT pickup_lifecycle CHECK (
          (status = 'requested' AND collector_id IS NULL AND accepted_at IS NULL AND collected_at IS NULL AND actual_grams IS NULL AND final_rate_id IS NULL AND final_paise_per_kg IS NULL AND final_amount_paise IS NULL)
          OR (status = 'accepted' AND collector_id IS NOT NULL AND accepted_at IS NOT NULL AND collected_at IS NULL AND actual_grams IS NULL AND final_rate_id IS NULL AND final_paise_per_kg IS NULL AND final_amount_paise IS NULL)
          OR (status = 'collected' AND collector_id IS NOT NULL AND accepted_at IS NOT NULL AND collected_at IS NOT NULL AND actual_grams IS NOT NULL AND final_rate_id IS NOT NULL AND final_paise_per_kg IS NOT NULL AND final_amount_paise IS NOT NULL AND cancelled_at IS NULL)
          -- Cancelled rows are terminal and never settle; the collector and the
          -- existing estimate are kept so history stays readable.
          OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND collected_at IS NULL AND actual_grams IS NULL AND final_rate_id IS NULL AND final_paise_per_kg IS NULL AND final_amount_paise IS NULL)
        ),
        -- A dispute is all-or-nothing: a status always carries its reason and
        -- its raised timestamp, and resolution always carries a timestamp.
        CONSTRAINT pickup_dispute_shape CHECK (
          (dispute_status IS NULL AND dispute_reason IS NULL AND dispute_raised_at IS NULL AND dispute_resolved_at IS NULL)
          OR (dispute_status = 'open' AND dispute_reason IS NOT NULL AND dispute_raised_at IS NOT NULL AND dispute_resolved_at IS NULL)
          OR (dispute_status IN ('resolved','rejected') AND dispute_reason IS NOT NULL AND dispute_raised_at IS NOT NULL AND dispute_resolved_at IS NOT NULL)
        ),
        CONSTRAINT pickup_item_shape CHECK (
          (category_id IS NULL AND category_name IS NULL AND rate_id IS NULL AND paise_per_kg IS NULL AND amount_paise IS NULL AND material IS NOT NULL)
          OR (category_id IS NOT NULL AND category_name IS NOT NULL AND rate_id IS NOT NULL AND paise_per_kg IS NOT NULL AND amount_paise IS NOT NULL AND material IS NULL)
        )
      )`);
      await c.query(`CREATE TABLE kabadi_pickup.payouts (
        -- One payout per request, ever. A second payment needs a new request, not
        -- an edit of this row: an amount that has been paid must never move.
        request_id uuid PRIMARY KEY REFERENCES kabadi_pickup.requests(id) ON DELETE RESTRICT,
        collector_id text NOT NULL REFERENCES kabadi_authz.accounts(user_id) ON DELETE RESTRICT,
        amount_paise bigint NOT NULL CHECK (amount_paise >= 0),
        method text NOT NULL CHECK (method IN ('cash','transfer','adjustment')),
        reference text CHECK (reference IS NULL OR char_length(reference) BETWEEN 1 AND 100),
        paid_at timestamptz NOT NULL DEFAULT now(),
        recorded_by text NOT NULL REFERENCES kabadi_authz.accounts(user_id) ON DELETE RESTRICT,
        note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 200)
      )`);
      await c.query('CREATE INDEX payout_collector ON kabadi_pickup.payouts (collector_id, paid_at DESC)');
      await c.query('CREATE INDEX ON kabadi_pickup.requests (user_id, created_at DESC, id DESC)');
      await c.query("CREATE INDEX pickup_open ON kabadi_pickup.requests (created_at) WHERE status='requested' AND category_id IS NOT NULL");
      await c.query("CREATE INDEX pickup_collector ON kabadi_pickup.requests (collector_id, status)");
      await c.query('INSERT INTO kabadi_pickup.schema_version VALUES (6)');
    }
    if (currentVersion === 1) {
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
      currentVersion = 2;
    }
    if (currentVersion === 2) {
      // Collection adds the collector, the measured weight and the final price.
      // Existing rows are all 'requested' and satisfy the new lifecycle check.
      await c.query(`ALTER TABLE kabadi_pickup.requests DROP CONSTRAINT IF EXISTS requests_status_check`);
      await c.query(`ALTER TABLE kabadi_pickup.requests ADD CONSTRAINT requests_status_check CHECK (status IN ('requested','accepted','collected'))`);
      await c.query(`ALTER TABLE kabadi_pickup.requests
        ADD COLUMN collector_id text REFERENCES kabadi_authz.accounts(user_id) ON DELETE RESTRICT,
        ADD COLUMN accepted_at timestamptz,
        ADD COLUMN collected_at timestamptz,
        ADD COLUMN actual_grams integer CHECK (actual_grams BETWEEN 1 AND 10000000),
        ADD COLUMN final_rate_id uuid REFERENCES kabadi_catalog.rates(id) ON DELETE RESTRICT,
        ADD COLUMN final_paise_per_kg integer CHECK (final_paise_per_kg BETWEEN 0 AND 1000000000),
        ADD COLUMN final_amount_paise bigint CHECK (final_amount_paise >= 0)`);
      await c.query(`ALTER TABLE kabadi_pickup.requests ADD CONSTRAINT pickup_lifecycle CHECK (
          (status = 'requested' AND collector_id IS NULL AND accepted_at IS NULL AND collected_at IS NULL AND actual_grams IS NULL AND final_rate_id IS NULL AND final_paise_per_kg IS NULL AND final_amount_paise IS NULL)
          OR (status = 'accepted' AND collector_id IS NOT NULL AND accepted_at IS NOT NULL AND collected_at IS NULL AND actual_grams IS NULL AND final_rate_id IS NULL AND final_paise_per_kg IS NULL AND final_amount_paise IS NULL)
          OR (status = 'collected' AND collector_id IS NOT NULL AND accepted_at IS NOT NULL AND collected_at IS NOT NULL AND actual_grams IS NOT NULL AND final_rate_id IS NOT NULL AND final_paise_per_kg IS NOT NULL AND final_amount_paise IS NOT NULL)
        )`);
      await c.query("CREATE INDEX pickup_open ON kabadi_pickup.requests (created_at) WHERE status='requested' AND category_id IS NOT NULL");
      await c.query('CREATE INDEX pickup_collector ON kabadi_pickup.requests (collector_id, status)');
      await c.query('ALTER TABLE kabadi_pickup.schema_version DROP CONSTRAINT IF EXISTS schema_version_version_check');
      await c.query('UPDATE kabadi_pickup.schema_version SET version = 3');
      await c.query('ALTER TABLE kabadi_pickup.schema_version ADD CONSTRAINT schema_version_version_check CHECK (version = 3)');
      currentVersion = 3;
    }
    if (currentVersion === 3) {
      // Cancellation is terminal and never settles. Releasing a claim is not a
      // status change: the row goes back to 'requested' with no collector, and
      // released_at records that it was once claimed.
      await c.query('ALTER TABLE kabadi_pickup.requests DROP CONSTRAINT IF EXISTS requests_status_check');
      await c.query(`ALTER TABLE kabadi_pickup.requests ADD CONSTRAINT requests_status_check CHECK (status IN ('requested','accepted','collected','cancelled'))`);
      await c.query(`ALTER TABLE kabadi_pickup.requests
        ADD COLUMN cancelled_at timestamptz,
        ADD COLUMN cancellation_reason text CHECK (cancellation_reason IS NULL OR char_length(cancellation_reason) BETWEEN 1 AND 200),
        ADD COLUMN released_at timestamptz`);
      await c.query('ALTER TABLE kabadi_pickup.requests DROP CONSTRAINT IF EXISTS pickup_lifecycle');
      await c.query(`ALTER TABLE kabadi_pickup.requests ADD CONSTRAINT pickup_lifecycle CHECK (
          (status = 'requested' AND collector_id IS NULL AND accepted_at IS NULL AND collected_at IS NULL AND actual_grams IS NULL AND final_rate_id IS NULL AND final_paise_per_kg IS NULL AND final_amount_paise IS NULL AND cancelled_at IS NULL)
          OR (status = 'accepted' AND collector_id IS NOT NULL AND accepted_at IS NOT NULL AND collected_at IS NULL AND actual_grams IS NULL AND final_rate_id IS NULL AND final_paise_per_kg IS NULL AND final_amount_paise IS NULL AND cancelled_at IS NULL)
          OR (status = 'collected' AND collector_id IS NOT NULL AND accepted_at IS NOT NULL AND collected_at IS NOT NULL AND actual_grams IS NOT NULL AND final_rate_id IS NOT NULL AND final_paise_per_kg IS NOT NULL AND final_amount_paise IS NOT NULL AND cancelled_at IS NULL)
          OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND collected_at IS NULL AND actual_grams IS NULL AND final_rate_id IS NULL AND final_paise_per_kg IS NULL AND final_amount_paise IS NULL)
        )`);
      // A cancellation reason is only meaningful on a cancelled row.
      await c.query(`ALTER TABLE kabadi_pickup.requests ADD CONSTRAINT pickup_cancel_reason CHECK (
          (status = 'cancelled') OR (cancellation_reason IS NULL))`);
      await c.query('ALTER TABLE kabadi_pickup.schema_version DROP CONSTRAINT IF EXISTS schema_version_version_check');
      await c.query('UPDATE kabadi_pickup.schema_version SET version = 4');
      await c.query('ALTER TABLE kabadi_pickup.schema_version ADD CONSTRAINT schema_version_version_check CHECK (version = 4)');
      currentVersion = 4;
    }
    if (currentVersion === 4) {
      // Disputes are a conversational record on the row, not a new table: a
      // request has at most one dispute, and keeping it beside the settlement
      // makes it impossible to read one without the other.
      await c.query(`ALTER TABLE kabadi_pickup.requests
        ADD COLUMN dispute_status text CHECK (dispute_status IS NULL OR dispute_status IN ('open','resolved','rejected')),
        ADD COLUMN dispute_reason text CHECK (dispute_reason IS NULL OR char_length(dispute_reason) BETWEEN 1 AND 200),
        ADD COLUMN dispute_raised_at timestamptz,
        ADD COLUMN dispute_resolved_at timestamptz`);
      await c.query(`ALTER TABLE kabadi_pickup.requests ADD CONSTRAINT pickup_dispute_shape CHECK (
          (dispute_status IS NULL AND dispute_reason IS NULL AND dispute_raised_at IS NULL AND dispute_resolved_at IS NULL)
          OR (dispute_status = 'open' AND dispute_reason IS NOT NULL AND dispute_raised_at IS NOT NULL AND dispute_resolved_at IS NULL)
          OR (dispute_status IN ('resolved','rejected') AND dispute_reason IS NOT NULL AND dispute_raised_at IS NOT NULL AND dispute_resolved_at IS NOT NULL)
        )`);
      await c.query('ALTER TABLE kabadi_pickup.schema_version DROP CONSTRAINT IF EXISTS schema_version_version_check');
      await c.query('UPDATE kabadi_pickup.schema_version SET version = 5');
      await c.query('ALTER TABLE kabadi_pickup.schema_version ADD CONSTRAINT schema_version_version_check CHECK (version = 5)');
      currentVersion = 5;
    }
    if (currentVersion === 5) {
      // Payout is a ledger, not a status flag on the request. Keeping it in its
      // own table means a settled amount is a fact with a timestamp and a
      // recorder, and the primary key makes double payment impossible.
      await c.query(`CREATE TABLE IF NOT EXISTS kabadi_pickup.payouts (
        request_id uuid PRIMARY KEY REFERENCES kabadi_pickup.requests(id) ON DELETE RESTRICT,
        collector_id text NOT NULL REFERENCES kabadi_authz.accounts(user_id) ON DELETE RESTRICT,
        amount_paise bigint NOT NULL CHECK (amount_paise >= 0),
        method text NOT NULL CHECK (method IN ('cash','transfer','adjustment')),
        reference text CHECK (reference IS NULL OR char_length(reference) BETWEEN 1 AND 100),
        paid_at timestamptz NOT NULL DEFAULT now(),
        recorded_by text NOT NULL REFERENCES kabadi_authz.accounts(user_id) ON DELETE RESTRICT,
        note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 200)
      )`);
      await c.query('CREATE INDEX IF NOT EXISTS payout_collector ON kabadi_pickup.payouts (collector_id, paid_at DESC)');
      await c.query('ALTER TABLE kabadi_pickup.schema_version DROP CONSTRAINT IF EXISTS schema_version_version_check');
      await c.query('UPDATE kabadi_pickup.schema_version SET version = 6');
      await c.query('ALTER TABLE kabadi_pickup.schema_version ADD CONSTRAINT schema_version_version_check CHECK (version = 6)');
      currentVersion = 6;
    }
    // The version row is a claim; verify the columns it promises. Without this a
    // half-applied upgrade looks identical to a finished one and the migration
    // would cheerfully report "nothing changed" over a broken table.
    const V3_COLUMNS = ['collector_id', 'accepted_at', 'collected_at', 'actual_grams',
      'final_rate_id', 'final_paise_per_kg', 'final_amount_paise',
      'cancelled_at', 'cancellation_reason', 'released_at',
      'dispute_status', 'dispute_reason', 'dispute_raised_at', 'dispute_resolved_at'];
    const found = await c.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='kabadi_pickup' AND table_name='requests' AND column_name = ANY($1::text[])`, [V3_COLUMNS]);
    const presentColumns = new Set(found.rows.map(r => r.column_name));
    const absent = V3_COLUMNS.filter(name => !presentColumns.has(name));
    // The payout ledger lives in its own table, so a version row alone says
    // nothing about it; verify the table and its key columns too.
    const payoutColumns = ['request_id', 'collector_id', 'amount_paise', 'method', 'paid_at', 'recorded_by'];
    const payoutFound = await c.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='kabadi_pickup' AND table_name='payouts' AND column_name = ANY($1::text[])`, [payoutColumns]);
    const payoutPresent = new Set(payoutFound.rows.map(r => r.column_name));
    const absentPayout = payoutColumns.filter(name => !payoutPresent.has(name));
    if (absent.length || absentPayout.length) {
      throw Error(`Pickup schema claims version ${currentVersion} but is missing: ${
        [...absent, ...absentPayout.map(n => `payouts.${n}`)].join(', ')}`);
    }
    // Report the outcome truthfully: an in-place upgrade is not the same event
    // as a fresh schema, and legacy rows are the operator's main concern.
    const counts = await c.query<{ legacy: string; total: string }>(
      `SELECT count(*) FILTER (WHERE category_id IS NULL)::text AS legacy, count(*)::text AS total
       FROM kabadi_pickup.requests`);
    await c.query('COMMIT');
    return {
      action: startingVersion === 0 ? 'created' : startingVersion < 6 ? 'upgraded' : 'unchanged',
      schemaVersion: 6,
      fromVersion: startingVersion,
      legacyRequests: Number(counts.rows[0]?.legacy ?? 0),
    };
  } catch (error) { try { await c.query('ROLLBACK'); } catch {} throw error; } finally { c.release(); }
}

type StoredPickup = { category_id: string | null; estimated_grams: number; category_name: string | null; rate_id: string | null; paise_per_kg: number | null; amount_paise: string | null };
export type StoredRequest = StoredPickup & {
  material: string | null;
  id: string; status: 'requested' | 'accepted' | 'collected' | 'cancelled'; created_at: Date;
  name: string; address_line: string; city: string; state: string; postal_code: string;
  actual_grams: number | null; final_rate_id: string | null; final_paise_per_kg: number | null;
  final_amount_paise: string | null; collected_at: Date | null;
  cancelled_at: Date | null; cancellation_reason: string | null; released_at: Date | null;
  dispute_status: 'open' | 'resolved' | 'rejected' | null;
  dispute_reason: string | null; dispute_raised_at: Date | null; dispute_resolved_at: Date | null;
  payout_amount_paise: string | null; payout_method: string | null;
  payout_paid_at: Date | null;
};

export const toPickup = (r: StoredRequest): Pickup => ({
  id: r.id, status: r.status, createdAt: r.created_at.toISOString(),
  address: { name: r.name, addressLine: r.address_line, city: r.city, state: r.state, postalCode: r.postal_code },
  estimatedGrams: r.estimated_grams, material: r.material,
  categoryId: r.category_id, categoryName: r.category_name, rateId: r.rate_id,
  paisePerKg: r.paise_per_kg, amountPaise: r.amount_paise,
  actualGrams: r.actual_grams, finalRateId: r.final_rate_id,
  finalPaisePerKg: r.final_paise_per_kg, finalAmountPaise: r.final_amount_paise,
  collectedAt: r.collected_at ? r.collected_at.toISOString() : null,
  cancelledAt: r.cancelled_at ? r.cancelled_at.toISOString() : null,
  cancellationReason: r.cancellation_reason,
  releasedAt: r.released_at ? r.released_at.toISOString() : null,
  dispute: r.dispute_status === null || !r.dispute_reason || !r.dispute_raised_at ? null : {
    status: r.dispute_status,
    raisedAt: r.dispute_raised_at.toISOString(),
    reason: r.dispute_reason,
    resolvedAt: r.dispute_resolved_at ? r.dispute_resolved_at.toISOString() : null,
  },
  // A half-written receipt (an amount with no method, say) is corrupt data, not
  // "unpaid": surface it as an error instead of quietly claiming no payout.
  payout: r.payout_amount_paise === null && r.payout_paid_at === null && r.payout_method === null ? null : (() => {
    // The CHECK constraint should make a bad method impossible; if one appears
    // anyway the schema has drifted, so refuse rather than pass it to a caller.
    if (r.payout_amount_paise === null || r.payout_paid_at === null || !isPayoutMethod(r.payout_method)) {
      throw Error('Invalid result');
    }
    return { amountPaise: r.payout_amount_paise, method: r.payout_method, paidAt: r.payout_paid_at.toISOString() };
  })(),
});

// Columns every read returns, kept in one place so the two list queries and the
// collector queries cannot drift apart.
// Column list plus the optional payout receipt. Every query aliases the request
// table as `r` and left-joins the ledger, so a row is never N+1 queried.
const PICKUP_COLUMNS = `r.id,r.status,r.created_at,r.name,r.address_line,r.city,r.state,r.postal_code,
  r.estimated_grams,r.material,r.category_id,r.category_name,r.rate_id,r.paise_per_kg,
  r.amount_paise::text AS amount_paise,r.actual_grams,r.final_rate_id,r.final_paise_per_kg,
  r.final_amount_paise::text AS final_amount_paise,r.collected_at,r.cancelled_at,r.cancellation_reason,
  r.released_at,r.dispute_status,r.dispute_reason,r.dispute_raised_at,r.dispute_resolved_at,
  p.amount_paise::text AS payout_amount_paise,p.method AS payout_method,p.paid_at AS payout_paid_at`;
const PICKUP_FROM = `kabadi_pickup.requests r
  LEFT JOIN kabadi_pickup.payouts p ON p.request_id = r.id`;

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
        const rows = await c.query<StoredRequest>(
          `SELECT ${PICKUP_COLUMNS}
           FROM kabadi_pickup.requests WHERE user_id=$1 ORDER BY created_at DESC, id DESC LIMIT 50`, [userId]);
        return rows.rows.map(toPickup);
      });
    },
    // Disputing is the customer's own challenge to a settled amount. The row
    // keeps its settlement untouched while the dispute is open: hiding the
    // disputed figure from either party would make the conversation impossible.
    async raiseDispute(userId: string, requestId: string, reason: string): Promise<DisputeOutcome | 'forbidden'> {
      if (typeof requestId !== 'string' || !UUID_V4.test(requestId)) throw Error('Invalid request id');
      if (typeof reason !== 'string' || !reason || reason.length > 200) throw Error('Invalid reason');
      return execute(userId, async c => {
        // Only a collected, undisputed row of this caller's can be disputed. The
        // guard is in the UPDATE so two taps cannot both succeed.
        const updated = await c.query(
          `UPDATE kabadi_pickup.requests
             SET dispute_status='open', dispute_reason=$3, dispute_raised_at=now(), dispute_resolved_at=NULL
           WHERE id=$1 AND user_id=$2 AND status='collected'
             AND (dispute_status IS NULL OR dispute_status='rejected') RETURNING id`, [requestId, userId, reason]);
        if (updated.rowCount === 1) return { outcome: 'raised' as const };
        const current = await c.query<{ status: string; owner: boolean; dispute_status: string | null }>(
          'SELECT status, user_id=$2 AS owner, dispute_status FROM kabadi_pickup.requests WHERE id=$1', [requestId, userId]);
        const found = current.rows[0];
        if (!found || !found.owner) return { outcome: 'not-found' as const };
        if (found.status !== 'collected') return { outcome: 'not-collected' as const };
        if (found.dispute_status === 'open') return { outcome: 'already-open' as const };
        return { outcome: 'not-found' as const };
      });
    },
    // Only the owning customer can cancel, and only before collection. The
    // conditional UPDATE makes the terminal state race-safe: a collection
    // finishing at the same moment wins, and the cancel reports that plainly.
    async cancel(userId: string, requestId: string, reason: string | null): Promise<CancelOutcome | 'forbidden'> {
      if (typeof requestId !== 'string' || !UUID_V4.test(requestId)) throw Error('Invalid request id');
      return execute(userId, async c => {
        const updated = await c.query(
          `UPDATE kabadi_pickup.requests
             SET status='cancelled', cancelled_at=now(), cancellation_reason=$3,
                 collector_id=NULL, accepted_at=NULL
           WHERE id=$1 AND user_id=$2 AND status IN ('requested','accepted') RETURNING id`,
          [requestId, userId, reason]);
        if (updated.rowCount === 1) return { outcome: 'cancelled' as const };
        const current = await c.query<{ status: string; owner: boolean }>(
          'SELECT status, user_id=$2 AS owner FROM kabadi_pickup.requests WHERE id=$1', [requestId, userId]);
        const found = current.rows[0];
        // Someone else's request is reported as absent, never as forbidden: the
        // existence of another customer's pickup is not this caller's business.
        if (!found || !found.owner) return { outcome: 'not-found' as const };
        if (found.status === 'cancelled') return { outcome: 'already-cancelled' as const };
        return { outcome: 'already-collected' as const };
      });
    },
  };
}

// A v3 request set while the database is still at v2 fails on missing columns.
// PostgreSQL reports that as SQLSTATE 42703 (undefined_column); recognising it
// lets the API tell the operator to migrate instead of "unavailable".
// Only the error code is inspected, never the message, so no SQL or data leaks.
export function isMissingCollectorColumns(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '42703';
}

// Admin-only dispute handling. The resolution re-prices at the rate frozen on
// the row at collection time; it never consults the catalog again, because a
// catalog lookup today would silently apply a newer price to an older pickup.
export function createDisputeStore(pool: pg.Pool) {
  async function asAdmin<T>(actorId: string, action: (c: pg.PoolClient) => Promise<T>): Promise<T | 'forbidden'> {
    if (typeof actorId !== 'string' || !actorId.trim()) throw Error('Invalid identity');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const account = await c.query<{ status: string }>('SELECT status FROM kabadi_authz.accounts WHERE user_id=$1 FOR UPDATE', [actorId]);
      if (account.rows[0]?.status !== 'active') { await c.query('COMMIT'); return 'forbidden'; }
      const grant = await c.query("SELECT 1 FROM kabadi_authz.role_grants WHERE user_id=$1 AND role='admin' FOR SHARE", [actorId]);
      if (grant.rowCount !== 1) { await c.query('COMMIT'); return 'forbidden'; }
      const result = await action(c); await c.query('COMMIT'); return result;
    } catch (error) { try { await c.query('ROLLBACK'); } catch {} throw error; } finally { c.release(); }
  }
  return {
    // The admin's queue: open disputes, oldest first, with the settlement intact.
    async openDisputes(actorId: string): Promise<Pickup[] | 'forbidden'> {
      return asAdmin(actorId, async c => {
        const rows = await c.query<StoredRequest>(
          `SELECT ${PICKUP_COLUMNS} FROM ${PICKUP_FROM}
           WHERE r.dispute_status='open' ORDER BY r.dispute_raised_at ASC, r.id ASC LIMIT 50`);
        return rows.rows.map(toPickup);
      });
    },
    // Resolving means accepting a corrected weight. The collector is kept as the
    // party who measured; the admin is recorded only through the audit trail.
    async resolveDispute(actorId: string, requestId: string, correctedGrams: unknown): Promise<DisputeOutcome | 'forbidden'> {
      if (typeof requestId !== 'string' || !UUID_V4.test(requestId)) throw Error('Invalid request id');
      if (typeof correctedGrams !== 'number' || !Number.isInteger(correctedGrams) ||
          correctedGrams < 1 || correctedGrams > MAX_GRAMS) throw Error('Invalid weight');
      return asAdmin(actorId, async c => {
        const locked = await c.query<{ status: string; dispute_status: string | null; actual_grams: number;
          final_paise_per_kg: number; final_rate_id: string }>(
          `SELECT status, dispute_status, actual_grams, final_paise_per_kg, final_rate_id
           FROM kabadi_pickup.requests WHERE id=$1 FOR UPDATE`, [requestId]);
        const found = locked.rows[0];
        if (!found) return { outcome: 'not-found' as const };
        if (found.status !== 'collected') return { outcome: 'not-collected' as const };
        if (found.dispute_status !== 'open') return { outcome: 'none-open' as const };
        if (found.actual_grams === correctedGrams) return { outcome: 'same-weight' as const };
        // The frozen per-kg rate is the whole point: re-price with the number
        // that was in force when the pickup happened.
        const estimate = calculateEstimate(correctedGrams, found.final_paise_per_kg);
        if (!estimate) throw Error('Invalid estimate');
        const updated = await c.query(
          `UPDATE kabadi_pickup.requests
             SET actual_grams=$2, final_amount_paise=$3::bigint,
                 dispute_status='resolved', dispute_resolved_at=now()
           WHERE id=$1 AND status='collected' AND dispute_status='open' RETURNING id`,
          [requestId, correctedGrams, estimate.amountPaise]);
        if (updated.rowCount !== 1) throw Error('Concurrent resolution');
        return { outcome: 'resolved' as const, finalAmountPaise: estimate.amountPaise,
          finalPaisePerKg: found.final_paise_per_kg, actualGrams: correctedGrams };
      });
    },
    // Rejecting keeps the original settlement and records that it was reviewed.
    async rejectDispute(actorId: string, requestId: string): Promise<DisputeOutcome | 'forbidden'> {
      if (typeof requestId !== 'string' || !UUID_V4.test(requestId)) throw Error('Invalid request id');
      return asAdmin(actorId, async c => {
        const updated = await c.query(
          `UPDATE kabadi_pickup.requests
             SET dispute_status='rejected', dispute_resolved_at=now()
           WHERE id=$1 AND status='collected' AND dispute_status='open' RETURNING id`, [requestId]);
        if (updated.rowCount === 1) return { outcome: 'rejected' as const };
        const current = await c.query<{ status: string; dispute_status: string | null }>(
          'SELECT status, dispute_status FROM kabadi_pickup.requests WHERE id=$1', [requestId]);
        const found = current.rows[0];
        if (!found) return { outcome: 'not-found' as const };
        if (found.status !== 'collected') return { outcome: 'not-collected' as const };
        return { outcome: 'none-open' as const };
      });
    },
  };
}

// Admin-only payout ledger. Recording a payment never changes the settlement;
// it records that this collector was handed this amount by this person.
export function createPayoutStore(pool: pg.Pool) {
  async function asAdmin<T>(actorId: string, action: (c: pg.PoolClient) => Promise<T>): Promise<T | 'forbidden'> {
    if (typeof actorId !== 'string' || !actorId.trim()) throw Error('Invalid identity');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const account = await c.query<{ status: string }>('SELECT status FROM kabadi_authz.accounts WHERE user_id=$1 FOR UPDATE', [actorId]);
      if (account.rows[0]?.status !== 'active') { await c.query('COMMIT'); return 'forbidden'; }
      const grant = await c.query("SELECT 1 FROM kabadi_authz.role_grants WHERE user_id=$1 AND role='admin' FOR SHARE", [actorId]);
      if (grant.rowCount !== 1) { await c.query('COMMIT'); return 'forbidden'; }
      const result = await action(c); await c.query('COMMIT'); return result;
    } catch (error) { try { await c.query('ROLLBACK'); } catch {} throw error; } finally { c.release(); }
  }
  return {
    // Collected, undisputed, still unpaid. An open dispute is excluded because
    // paying an amount under challenge would make the correction meaningless.
    async unpaidCollectorDues(actorId: string): Promise<Pickup[] | 'forbidden'> {
      return asAdmin(actorId, async c => {
        const rows = await c.query<StoredRequest>(
          `SELECT ${PICKUP_COLUMNS} FROM ${PICKUP_FROM}
           WHERE r.status='collected' AND p.request_id IS NULL
             AND (r.dispute_status IS NULL OR r.dispute_status='rejected')
           ORDER BY r.collected_at ASC, r.id ASC LIMIT 50`);
        return rows.rows.map(toPickup);
      });
    },
    async recordPayout(actorId: string, requestId: string, method: unknown, reference: unknown, note: unknown): Promise<PayoutOutcome | 'forbidden'> {
      if (typeof requestId !== 'string' || !UUID_V4.test(requestId)) throw Error('Invalid request id');
      // One list, one guard: a new method must be added to PAYOUT_METHODS and to
      // the CHECK constraint together, or both the schema and this refusal break.
      if (!isPayoutMethod(method)) throw Error('Invalid method');
      return asAdmin(actorId, async c => {
        const locked = await c.query<{ status: string; collector_id: string | null; final_amount_paise: string | null;
          dispute_status: string | null; paid: boolean }>(
          `SELECT r.status, r.collector_id, r.final_amount_paise::text AS final_amount_paise, r.dispute_status,
                  (p.request_id IS NOT NULL) AS paid
           FROM kabadi_pickup.requests r
           LEFT JOIN kabadi_pickup.payouts p ON p.request_id = r.id
           WHERE r.id=$1 FOR UPDATE OF r`, [requestId]);
        const found = locked.rows[0];
        if (!found) return { outcome: 'not-found' as const };
        if (found.status !== 'collected') return { outcome: 'not-collected' as const };
        if (found.paid) return { outcome: 'already-paid' as const };
        // An open dispute means the amount is not final; refuse rather than pay
        // a figure that may still change.
        if (found.dispute_status === 'open') return { outcome: 'disputed' as const };
        if (found.collector_id === null || found.final_amount_paise === null) throw Error('Invalid settlement');
        // The primary key on request_id is the real guard against double payment;
        // the ON CONFLICT keeps a concurrent attempt a clean refusal, not a crash.
        const inserted = await c.query(
          `INSERT INTO kabadi_pickup.payouts (request_id, collector_id, amount_paise, method, reference, recorded_by, note)
           VALUES ($1,$2,$3::bigint,$4,$5,$6,$7)
           ON CONFLICT (request_id) DO NOTHING RETURNING request_id`,
          [requestId, found.collector_id, found.final_amount_paise, method, reference, actorId, note]);
        if (inserted.rowCount !== 1) return { outcome: 'already-paid' as const };
        return { outcome: 'paid' as const, amountPaise: found.final_amount_paise, method };
      });
    },
  };
}

export type CollectorOutcome =
  | { outcome: 'accepted' }
  | { outcome: 'collected'; finalAmountPaise: string; finalPaisePerKg: number; finalRateId: string; actualGrams: number }
  | { outcome: 'released' }
  | { outcome: 'not-found' | 'already-accepted' | 'not-accepted' | 'already-collected'
      | 'no-rate' | 'legacy-request' | 'own-request' | 'cancelled' | 'not-owner' };

// Collector-side actions. Every method derives the actor from the session and
// re-checks the collector grant inside the transaction; ownership of a request
// never comes from the browser.
export function createCollectorStore(pool: pg.Pool) {
  async function asCollector<T>(userId: string, action: (c: pg.PoolClient) => Promise<T>): Promise<T | 'forbidden'> {
    if (typeof userId !== 'string' || !userId.trim()) throw Error('Invalid identity');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const account = await c.query<{ status: string }>('SELECT status FROM kabadi_authz.accounts WHERE user_id=$1 FOR UPDATE', [userId]);
      if (account.rows[0]?.status !== 'active') { await c.query('COMMIT'); return 'forbidden'; }
      const grant = await c.query("SELECT 1 FROM kabadi_authz.role_grants WHERE user_id=$1 AND role='collector' FOR SHARE", [userId]);
      if (grant.rowCount !== 1) { await c.query('COMMIT'); return 'forbidden'; }
      const result = await action(c); await c.query('COMMIT'); return result;
    } catch (error) { try { await c.query('ROLLBACK'); } catch {} throw error; } finally { c.release(); }
  }
  return {
    // Open work is visible to every active collector. Only priced requests are
    // offered: a legacy free-text row has no category to price at collection.
    async open(userId: string): Promise<Pickup[] | 'forbidden'> {
      return asCollector(userId, async c => {
        const rows = await c.query<StoredRequest>(
          `SELECT ${PICKUP_COLUMNS} FROM ${PICKUP_FROM}
           WHERE r.status='requested' AND r.category_id IS NOT NULL
           ORDER BY r.created_at ASC, r.id ASC LIMIT 50`);
        return rows.rows.map(toPickup);
      });
    },
    async mine(userId: string): Promise<Pickup[] | 'forbidden'> {
      return asCollector(userId, async c => {
        const rows = await c.query<StoredRequest>(
          `SELECT ${PICKUP_COLUMNS} FROM ${PICKUP_FROM}
           WHERE r.collector_id=$1 ORDER BY r.created_at DESC, r.id DESC LIMIT 50`, [userId]);
        return rows.rows.map(toPickup);
      });
    },
    // First acceptance wins. The conditional UPDATE is the race resolution: only
    // one statement can move a row out of 'requested'.
    async accept(userId: string, requestId: string): Promise<CollectorOutcome | 'forbidden'> {
      if (typeof requestId !== 'string' || !UUID_V4.test(requestId)) throw Error('Invalid request id');
      return asCollector(userId, async c => {
        // A collector must never take their own request: they would set the
        // weight and receive the money at a price they chose to accept.
        const updated = await c.query(
          `UPDATE kabadi_pickup.requests SET status='accepted', collector_id=$2, accepted_at=now()
           WHERE id=$1 AND status='requested' AND category_id IS NOT NULL AND user_id <> $2 RETURNING id`,
          [requestId, userId]);
        if (updated.rowCount === 1) return { outcome: 'accepted' as const };
        const current = await c.query<{ status: string; category_id: string | null; user_id: string }>(
          'SELECT status, category_id, user_id FROM kabadi_pickup.requests WHERE id=$1', [requestId]);
        const found = current.rows[0];
        if (!found) return { outcome: 'not-found' as const };
        if (found.category_id === null) return { outcome: 'legacy-request' as const };
        // Still 'requested' after the guarded UPDATE can only mean the ordering
        // constraint held: the requester is this collector.
        if (found.status === 'requested') return { outcome: 'own-request' as const };
        if (found.status === 'cancelled') return { outcome: 'cancelled' as const };
        return { outcome: 'already-accepted' as const };
      });
    },
    // Collection settles the request: the final rate is the newest rate already
    // in force at collection time, not the rate snapshotted at request time.
    async collect(userId: string, requestId: string, rawGrams: unknown): Promise<CollectorOutcome | 'forbidden'> {
      if (typeof requestId !== 'string' || !UUID_V4.test(requestId)) throw Error('Invalid request id');
      const grams = rawGrams;
      if (typeof grams !== 'number' || !Number.isInteger(grams) || grams < 1 || grams > MAX_GRAMS) throw Error('Invalid weight');
      return asCollector(userId, async c => {
        const locked = await c.query<{ status: string; collector_id: string | null; category_id: string | null }>(
          'SELECT status, collector_id, category_id FROM kabadi_pickup.requests WHERE id=$1 FOR UPDATE', [requestId]);
        const found = locked.rows[0];
        if (!found) return { outcome: 'not-found' as const };
        if (found.status === 'cancelled') return { outcome: 'cancelled' as const };
        if (found.status === 'collected') return { outcome: 'already-collected' as const };
        if (found.status !== 'accepted' || found.collector_id !== userId) return { outcome: 'not-accepted' as const };
        if (found.category_id === null) return { outcome: 'legacy-request' as const };
        const rate = await c.query<{ id: string; paise_per_kg: number }>(
          `SELECT id, paise_per_kg FROM kabadi_catalog.rates
           WHERE category_id=$1 AND effective_from <= clock_timestamp()
           ORDER BY effective_from DESC LIMIT 1`, [found.category_id]);
        const chosen = rate.rows[0];
        if (!chosen) return { outcome: 'no-rate' as const };
        const estimate = calculateEstimate(grams, chosen.paise_per_kg);
        if (!estimate) throw Error('Invalid estimate');
        const updated = await c.query(
          `UPDATE kabadi_pickup.requests SET status='collected', collected_at=now(), actual_grams=$2,
             final_rate_id=$3, final_paise_per_kg=$4, final_amount_paise=$5::bigint
           WHERE id=$1 AND status='accepted' AND collector_id=$6 RETURNING id`,
          [requestId, grams, chosen.id, chosen.paise_per_kg, estimate.amountPaise, userId]);
        if (updated.rowCount !== 1) throw Error('Concurrent collection');
        return { outcome: 'collected' as const, finalAmountPaise: estimate.amountPaise,
          finalPaisePerKg: chosen.paise_per_kg, finalRateId: chosen.id, actualGrams: grams };
      });
    },
    // Giving a claim back is not a cancellation: the customer still wants the
    // pickup, so the row returns to the open queue. released_at keeps the fact
    // that it was once claimed, which matters for dispute history.
    async release(userId: string, requestId: string): Promise<CollectorOutcome | 'forbidden'> {
      if (typeof requestId !== 'string' || !UUID_V4.test(requestId)) throw Error('Invalid request id');
      return asCollector(userId, async c => {
        const updated = await c.query(
          `UPDATE kabadi_pickup.requests
             SET status='requested', collector_id=NULL, accepted_at=NULL, released_at=now()
           WHERE id=$1 AND status='accepted' AND collector_id=$2 RETURNING id`, [requestId, userId]);
        if (updated.rowCount === 1) return { outcome: 'released' as const };
        const current = await c.query<{ status: string; collector_id: string | null }>(
          'SELECT status, collector_id FROM kabadi_pickup.requests WHERE id=$1', [requestId]);
        const found = current.rows[0];
        if (!found) return { outcome: 'not-found' as const };
        if (found.status === 'cancelled') return { outcome: 'cancelled' as const };
        if (found.status === 'collected') return { outcome: 'already-collected' as const };
        // 'requested' means someone released it or nobody claimed it; either way
        // there is no claim of this collector's to give back.
        if (found.status === 'requested') return { outcome: 'not-accepted' as const };
        return { outcome: 'not-accepted' as const };
      });
    },
  };
}
