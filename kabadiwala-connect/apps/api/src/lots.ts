import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { CHAIN_ROLES, type ChainRole } from './account-store.js';

// THE UPWARD SUPPLY CHAIN (tiers 1-4).
//
// A pickup ends with a collector holding material they have been paid for. From
// there it travels upward: collector -> shop -> mandi -> recycler. Until now
// there was nowhere to record that, so the platform's whole claim to be a
// chain-of-custody system rested on a table of pickups.
//
// A LOT is a quantity of one material sitting with one holder. It is created
// when a collector takes custody of a collected pickup, and it moves upward by
// being SOLD. Custody is never edited: a sale closes one lot and opens another
// at the buyer, so the history of who held what, when, for how much, is a
// sequence of immutable rows rather than a mutable "owner" column that forgets.
//
// Three invariants shape the schema, and each of them is the reason for a
// constraint rather than a comment:
//
// 1. WEIGHT IS CONSERVED. A sale declares what was SOLD, the receiving lot opens
//    at exactly that weight, and the difference between the lot's weight and the
//    sum of its sales is the remainder the holder still has. Nothing in this
//    module adjusts a weight in place, because a quantity that can be edited
//    after the money is agreed is not a chain of custody.
//
// 2. A LOT CANNOT BE SOLD TWICE. The sale is guarded by a conditional UPDATE on
//    the lot's status, so a second concurrent sale loses the race in the
//    database rather than in an application check that two requests can both
//    pass.
//
// 3. A LOT CANNOT BE SOLD TO ITSELF OR DOWNWARD. The buyer must hold the next
//    tier up and must not be the seller. Enforced inside the transaction, so a
//    crafted request cannot move material backward and launder it.

// Lot lifecycle. `sold` is terminal: the material left the holder. There is no
// 'lost' or 'adjusted' state, because inventing one without a custody event
// behind it would be a gap in the chain rather than a record of one.
export const LOT_STATUSES = ['held', 'sold'] as const;
export type LotStatus = typeof LOT_STATUSES[number];

// Collection is the one pickup state that puts material in a collector's hands.
const COLLECTED = 'collected';

export type Lot = {
  id: string;
  holderId: string;
  material: string;
  // Grams. Integer, like every weight in this project.
  grams: number;
  // What the holder paid for this material, in paise as a string (bigint).
  costPaise: string;
  status: LotStatus;
  // The pickup this lot came from, when it came from one. A lot may also be
  // opened from an earlier lot by a sale, in which case parentLotId is set.
  sourcePickupId: string | null;
  parentLotId: string | null;
  createdAt: string;
  soldAt: string | null;
};

// The seller is told what they sold and to which tier -- never which account
// bought it. The buyer's identity is the platform's record, not the seller's
// information, and a seller who learned it could route around the chain.
export type Sale = {
  id: string;
  lotId: string;
  sellerId: string;
  buyerTier: ChainRole | null;
  grams: number;
  pricePaise: string;
  // The lot opened at the buyer. Null only if the buyer is the terminal
  // recycler, whose material is processed rather than resold.
  buyerLotId: string | null;
  recordedAt: string;
};

// A sale as one particular account is allowed to see it. The physical trail --
// what weight moved, when, and which lot it became -- is shared, because that is
// what provenance means. The money on a trade somebody else made is not: a mandi
// who buys a shop's lot has no business learning what the shop paid the
// collector, and that is exactly the number that would leak.
export type PublicSale = {
  id: string;
  lotId: string;
  grams: number;
  // The tier that received the material, never the account that holds it.
  buyerTier: ChainRole | null;
  // Null when this account was neither side of the trade.
  pricePaise: string | null;
  buyerLotId: string | null;
  recordedAt: string;
  // Which side this account was on, or 'observer' for a trade they inherited.
  party: 'seller' | 'buyer' | 'observer';
};
const toPublicSale = (r: StoredSale, userId: string): PublicSale => {
  const party = r.seller_id === userId ? 'seller' as const : r.buyer_id === userId ? 'buyer' as const : 'observer' as const;
  const tier = r.buyer_tier && (CHAIN_ROLES as readonly string[]).includes(r.buyer_tier)
    ? r.buyer_tier as ChainRole : null;
  return { id: r.id, lotId: r.lot_id, grams: r.grams, buyerTier: tier,
    pricePaise: party === 'observer' ? null : r.price_paise,
    buyerLotId: r.buyer_lot_id, recordedAt: r.recorded_at.toISOString(), party };
};

type StoredLot = {
  id: string; holder_id: string; material: string; grams: number; cost_paise: string;
  status: LotStatus; source_pickup_id: string | null; parent_lot_id: string | null;
  created_at: Date; sold_at: Date | null;
};
type StoredSale = {
  id: string; lot_id: string; seller_id: string; buyer_id: string; grams: number;
  // The tier the material moved up to, frozen at the moment of the sale: grants
  // change over time, and a history that recalculated would rewrite the past.
  buyer_tier: string | null;
  price_paise: string; buyer_lot_id: string | null; recorded_at: Date;
};

const toLot = (r: StoredLot): Lot => ({
  id: r.id, holderId: r.holder_id, material: r.material, grams: r.grams,
  costPaise: r.cost_paise, status: r.status, sourcePickupId: r.source_pickup_id,
  parentLotId: r.parent_lot_id, createdAt: r.created_at.toISOString(),
  soldAt: r.sold_at ? r.sold_at.toISOString() : null,
});
const toSale = (r: StoredSale, buyerTier: ChainRole | null): Sale => ({
  id: r.id, lotId: r.lot_id, sellerId: r.seller_id, buyerTier,
  grams: r.grams, pricePaise: r.price_paise, buyerLotId: r.buyer_lot_id,
  recordedAt: r.recorded_at.toISOString(),
});

const LOT_COLUMNS = `id, holder_id, material, grams, cost_paise::text AS cost_paise, status,
  source_pickup_id, parent_lot_id, created_at, sold_at`;
const SALE_COLUMNS = `id, lot_id, seller_id, buyer_id, grams, buyer_tier,
  price_paise::text AS price_paise, buyer_lot_id, recorded_at`;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_GRAMS = 10_000_000;

// What a holder may declare when opening a lot from a pickup they collected.
// The weight is bounded by what the pickup actually recorded: a collector cannot
// conjure material that was never measured, which is the same reason the pickup
// store recomputes the amount rather than trusting the client.
export type OpenLotInput = { pickupId: string; material: string };
export function parseOpenLot(raw: unknown): OpenLotInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const allowed = new Set(['pickupId', 'material']);
  const keys = Object.keys(raw);
  if (keys.length !== 2 || keys.some(key => !allowed.has(key))) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.pickupId !== 'string' || !UUID_V4.test(v.pickupId)) return null;
  if (typeof v.material !== 'string') return null;
  const material = v.material.trim();
  if (!material || Array.from(material).length > 100) return null;
  if (/[\uD800-\uDFFF\u0000-\u001f\u007f-\u009f]/u.test(material)) return null;
  return { pickupId: v.pickupId, material };
}

export type SaleInput = { lotId: string; grams: number; pricePaise: string };
export function parseSale(raw: unknown): SaleInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const allowed = new Set(['lotId', 'grams', 'pricePaise']);
  const keys = Object.keys(raw);
  if (keys.length !== 3 || keys.some(key => !allowed.has(key))) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.lotId !== 'string' || !UUID_V4.test(v.lotId)) return null;
  if (typeof v.grams !== 'number' || !Number.isInteger(v.grams) || v.grams < 1 || v.grams > MAX_GRAMS) return null;
  // Paise as a decimal string, like every other amount here. Never a float: a
  // price that has been through binary floating point is not a price.
  if (typeof v.pricePaise !== 'string' || !/^\d{1,16}$/.test(v.pricePaise)) return null;
  return { lotId: v.lotId, grams: v.grams, pricePaise: v.pricePaise };
}

export const LOT_OUTCOMES = [
  'opened', 'sold', 'not-found', 'not-holder', 'already-sold', 'not-collector',
  'pickup-not-collected', 'pickup-already-lotted', 'not-a-chain-account',
  'no-next-tier', 'buyer-not-next-tier', 'buyer-same-account', 'invalid-weight',
] as const;
export type LotOutcome = { outcome: 'opened'; lot: Lot } | { outcome: 'sold'; sale: Sale; buyerLot: Lot | null }
  | { outcome: Exclude<typeof LOT_OUTCOMES[number], 'opened' | 'sold'> };

export function createLotStore(pool: pg.Pool) {
  // Every entry point resolves the actor's own grants inside the transaction and
  // never accepts a role from the caller.
  // `admin` is included so the store can tell "is an admin acting on behalf of a
  // collector" from "is a customer" without a second grant query. It is never a
  // tier in the chain and never changes who holds a lot.
  async function asChainMember<T>(userId: string, action: (c: pg.PoolClient, roles: (ChainRole | 'admin')[]) => Promise<T>): Promise<T | 'forbidden'> {
    if (typeof userId !== 'string' || !userId.trim()) throw Error('Invalid identity');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const account = await c.query<{ status: string }>(
        'SELECT status FROM kabadi_authz.accounts WHERE user_id=$1 FOR UPDATE', [userId]);
      if (account.rows[0]?.status !== 'active') { await c.query('COMMIT'); return 'forbidden'; }
      const grants = await c.query<{ role: string }>(
        'SELECT role FROM kabadi_authz.role_grants WHERE user_id=$1', [userId]);
      const roles = grants.rows.map(r => r.role).filter((r): r is ChainRole | 'admin' =>
        r === 'admin' || (CHAIN_ROLES as readonly string[]).includes(r));
      if (!roles.length) { await c.query('COMMIT'); return 'forbidden'; }
      const result = await action(c, roles); await c.query('COMMIT'); return result;
    } catch (error) { try { await c.query('ROLLBACK'); } catch {} throw error; } finally { c.release(); }
  }

  // The tier a holder acts at when selling. Admin is not in the chain; a person
  // with several chain grants sells at the HIGHEST tier they hold, because that
  // is the only tier at which anything is left for them to sell upward.
  const chainOnly = (roles: (ChainRole | 'admin')[]): ChainRole[] =>
    roles.filter((r): r is ChainRole => (CHAIN_ROLES as readonly string[]).includes(r));
  const sellingTier = (roles: (ChainRole | 'admin')[]): ChainRole | null => {
    const chain = chainOnly(roles);
    if (!chain.length) return null;
    return chain.reduce((highest, role) =>
      CHAIN_ROLES.indexOf(role) > CHAIN_ROLES.indexOf(highest) ? role : highest, chain[0]!);
  };

  return {
    parseOpenLot, parseSale,

    // A collector takes custody of material they measured and were paid for.
    // The lot's weight and cost come from the pickup row, never from the request:
    // a collector who could state their own tonnage could invent stock.
    async openFromPickup(userId: string, raw: unknown): Promise<LotOutcome | 'forbidden'> {
      const input = parseOpenLot(raw); if (!input) throw Error('Invalid lot');
      return asChainMember(userId, async (c, roles) => {
        if (!roles.includes('collector') && !roles.includes('admin')) return { outcome: 'not-collector' as const };
        const pickup = await c.query<{ status: string; collector_id: string | null; actual_grams: number | null;
          final_amount_paise: string | null }>(
          `SELECT status, collector_id, actual_grams, final_amount_paise::text AS final_amount_paise
           FROM kabadi_pickup.requests WHERE id=$1 FOR UPDATE`, [input.pickupId]);
        const found = pickup.rows[0];
        if (!found) return { outcome: 'pickup-not-collected' as const };
        if (found.status !== COLLECTED) return { outcome: 'pickup-not-collected' as const };
        // Only the collector who collected it may open the lot. An admin can do
        // it on their behalf, but the holder is always the collector.
        if (found.collector_id === null) return { outcome: 'pickup-not-collected' as const };
        if (found.collector_id !== userId && !roles.includes('admin')) return { outcome: 'not-holder' as const };
        if (found.actual_grams === null || found.final_amount_paise === null) return { outcome: 'pickup-not-collected' as const };
        // One lot per pickup. The unique index is the real guard; this read makes
        // the refusal a clean answer instead of a constraint violation.
        const existing = await c.query('SELECT 1 FROM kabadi_lots.lots WHERE source_pickup_id=$1', [input.pickupId]);
        if (existing.rowCount) return { outcome: 'pickup-already-lotted' as const };
        const inserted = await c.query<StoredLot>(
          `INSERT INTO kabadi_lots.lots (holder_id, material, grams, cost_paise, source_pickup_id)
           VALUES ($1,$2,$3,$4::bigint,$5) RETURNING ${LOT_COLUMNS}`,
          [found.collector_id, input.material, found.actual_grams, found.final_amount_paise, input.pickupId]);
        return { outcome: 'opened' as const, lot: toLot(inserted.rows[0]!) };
      });
    },

    // What this account is holding. A seller needs this to know what they can
    // offer; a buyer needs the same shape for what they have received.
    async held(userId: string): Promise<Lot[] | 'forbidden'> {
      return asChainMember(userId, async c => {
        const rows = await c.query<StoredLot>(
          `SELECT ${LOT_COLUMNS} FROM kabadi_lots.lots
           WHERE holder_id=$1 AND status='held' ORDER BY created_at ASC, id ASC LIMIT 100`, [userId]);
        return rows.rows.map(toLot);
      });
    },

    // Sell part or all of a lot one tier up. The buyer must hold exactly the
    // next tier; the app never guesses who the buyer is from a name.
    async sell(userId: string, raw: unknown): Promise<LotOutcome | 'forbidden'> {
      const input = parseSale(raw); if (!input) throw Error('Invalid sale');
      return asChainMember(userId, async (c, roles) => {
        const lot = await c.query<StoredLot>(
          `SELECT ${LOT_COLUMNS} FROM kabadi_lots.lots WHERE id=$1 FOR UPDATE`, [input.lotId]);
        const found = lot.rows[0];
        if (!found) return { outcome: 'not-found' as const };
        if (found.holder_id !== userId) return { outcome: 'not-holder' as const };
        if (found.status !== 'held') return { outcome: 'already-sold' as const };
        if (input.grams > found.grams) return { outcome: 'invalid-weight' as const };

        const sellerTier = sellingTier(roles);
        // An admin with no chain grant is not a seller: there is no tier for
        // them to sell from, and inventing one would let an operator move
        // material without ever having held it.
        if (!sellerTier) return { outcome: 'not-a-chain-account' as const };
        const buyerTier = CHAIN_ROLES[CHAIN_ROLES.indexOf(sellerTier) + 1];
        // A recycler is terminal: their material is processed, not resold.
        if (!buyerTier) return { outcome: 'no-next-tier' as const };

        // The buyer is chosen from the accounts that actually hold the next tier.
        // Picking the first is a deliberate placeholder for a real matching step
        // (offers, bids, proximity) -- but the tier check is not a placeholder.
        const buyer = await c.query<{ user_id: string }>(
          `SELECT a.user_id FROM kabadi_authz.accounts a
           JOIN kabadi_authz.role_grants g ON g.user_id = a.user_id AND g.role = $1
           WHERE a.status='active' AND a.user_id <> $2
           ORDER BY a.user_id LIMIT 1`, [buyerTier, userId]);
        const buyerId = buyer.rows[0]?.user_id;
        if (!buyerId) return { outcome: 'buyer-not-next-tier' as const };
        if (buyerId === userId) return { outcome: 'buyer-same-account' as const };

        // Consume the sold weight. A partial sale leaves the remainder with the
        // seller as a NEW open lot rather than shrinking this one, so the lot a
        // sale referred to is never mutated into a different quantity.
        const remainder = found.grams - input.grams;
        const closed = await c.query(
          `UPDATE kabadi_lots.lots SET status='sold', sold_at=now()
           WHERE id=$1 AND status='held' AND holder_id=$2 RETURNING id`, [input.lotId, userId]);
        if (closed.rowCount !== 1) return { outcome: 'already-sold' as const };

        // The buyer receives exactly what was sold, at the price that was agreed.
        // The recycler is terminal, so no onward lot is opened for them.
        let buyerLotId: string | null = null;
        if (buyerTier !== 'recycler') {
          const opened = await c.query<{ id: string }>(
            `INSERT INTO kabadi_lots.lots (holder_id, material, grams, cost_paise, parent_lot_id)
             VALUES ($1,$2,$3,$4::bigint,$5) RETURNING id`,
            [buyerId, found.material, input.grams, input.pricePaise, found.id]);
          buyerLotId = opened.rows[0]!.id;
        }
        // The remainder keeps the REMAINDER OF THE COST, not the whole cost. Copying
        // the lot's full basis onto a fraction of its weight would inflate the
        // seller's inventory the moment they sold part of it -- a 1000 g lot that
        // cost 100000 and sold 400 g would leave 600 g still "worth" 100000.
        // Pro-rata, rounded down, so the two halves can never add up to more than
        // the original basis. The arithmetic is done in bigint in the database:
        // cost is money, and money never passes through binary floating point.
        if (remainder > 0) {
          await c.query(
            `INSERT INTO kabadi_lots.lots (holder_id, material, grams, cost_paise, parent_lot_id)
             VALUES ($1,$2,$3,($4::bigint * $3::bigint) / $5::bigint,$6)`,
            [userId, found.material, remainder, found.cost_paise, found.grams, found.id]);
        }

        const sale = await c.query<StoredSale>(
          `INSERT INTO kabadi_lots.sales (lot_id, seller_id, buyer_id, grams, price_paise, buyer_lot_id, buyer_tier)
           VALUES ($1,$2,$3,$4,$5::bigint,$6,$7)
           RETURNING id, lot_id, seller_id, buyer_id, grams, buyer_tier, price_paise::text AS price_paise, buyer_lot_id, recorded_at`,
          [input.lotId, userId, buyerId, input.grams, input.pricePaise, buyerLotId, buyerTier]);
        const buyerLot = buyerLotId
          ? (await c.query<StoredLot>(`SELECT ${LOT_COLUMNS} FROM kabadi_lots.lots WHERE id=$1`, [buyerLotId])).rows[0]
          : null;
        return { outcome: 'sold' as const, sale: toSale(sale.rows[0]!, buyerTier), buyerLot: buyerLot ? toLot(buyerLot) : null };
      });
    },

    // The custody history of one lot: every sale it was part of, oldest first.
    // This is the question a recycler or an auditor actually asks.
    async history(userId: string, lotId: string): Promise<PublicSale[] | 'forbidden' | 'not-found'> {
      if (typeof lotId !== 'string' || !UUID_V4.test(lotId)) throw Error('Invalid lot id');
      return asChainMember(userId, async c => {
        // A member may read the history of a lot they hold or have held. Anything
        // else is reported as not-found rather than forbidden, so the endpoint
        // cannot be used to probe which lot ids exist.
        const mine = await c.query(
          `SELECT 1 FROM kabadi_lots.lots WHERE id=$1 AND holder_id=$2
           UNION SELECT 1 FROM kabadi_lots.sales WHERE lot_id=$1 AND (seller_id=$2 OR buyer_id=$2)
           UNION SELECT 1 FROM kabadi_lots.lots l JOIN kabadi_lots.sales s ON s.buyer_lot_id = l.id
             WHERE l.id=$1 AND (s.seller_id=$2 OR s.buyer_id=$2)`, [lotId, userId]);
        if (!mine.rowCount) return 'not-found' as const;
        const rows = await c.query<StoredSale>(
          `SELECT ${SALE_COLUMNS} FROM kabadi_lots.sales WHERE lot_id=$1 ORDER BY recorded_at ASC, id ASC`, [lotId]);
        return rows.rows.map(row => toPublicSale(row, userId));
      });
    },
  };
}
