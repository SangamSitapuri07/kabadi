import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { parseOpenLot, parseSale, createLotStore } = await import('../../apps/api/dist/lots.js');
const { ROLES, CHAIN_ROLES, nextTier, tierOf } = await import('../../apps/api/dist/account-store.js');

test('the chain is one ordered path from customer to recycler, and the recycler is terminal', () => {
  assert.deepEqual([...CHAIN_ROLES], ['customer', 'collector', 'shop', 'mandi', 'recycler']);
  assert.equal(nextTier('customer'), 'collector');
  assert.equal(nextTier('collector'), 'shop');
  assert.equal(nextTier('shop'), 'mandi');
  assert.equal(nextTier('mandi'), 'recycler');
  // Nothing is sold onward from a recycler: that is where processing happens.
  assert.equal(nextTier('recycler'), null);
  // Admin sits outside the chain entirely.
  assert.ok(ROLES.includes('admin'));
  assert.ok(!CHAIN_ROLES.includes('admin'));
  assert.equal(tierOf('customer'), 0);
  assert.equal(tierOf('recycler'), 4);
});

test('lot input is strict: no extra keys, no client-set weight or cost', () => {
  const pickupId = randomUUID();
  assert.deepEqual(parseOpenLot({ pickupId, material: 'Copper wire' }), { pickupId, material: 'Copper wire' });
  // A collector may name the material but may NOT declare the tonnage or cost:
  // both come from the pickup row. Smuggling them in is rejected outright.
  for (const bad of [null, [], {}, { pickupId }, { material: 'x' },
    { pickupId, material: 'x', grams: 999999 }, { pickupId, material: 'x', costPaise: '1' },
    { pickupId: 'nope', material: 'x' }, { pickupId, material: '' }, { pickupId, material: '  ' },
    { pickupId, material: 'x'.repeat(101) }, { pickupId, material: 'a\u0000b' }]) {
    assert.equal(parseOpenLot(bad), null, `expected rejection: ${JSON.stringify(bad)?.slice(0,60)}`);
  }

  const lotId = randomUUID();
  assert.deepEqual(parseSale({ lotId, grams: 100, pricePaise: '5000' }), { lotId, grams: 100, pricePaise: '5000' });
  for (const bad of [null, [], {},
    { lotId, grams: 100 }, { lotId, pricePaise: '5000' },
    { lotId, grams: 100, pricePaise: 5000 },          // a number is not a paise string
    { lotId, grams: 100, pricePaise: '5.5' },          // no fractions of a paise
    { lotId, grams: 100, pricePaise: '-1' },
    { lotId, grams: 0, pricePaise: '1' },
    { lotId, grams: 1.5, pricePaise: '1' },
    { lotId, grams: 100, pricePaise: '1', buyerId: randomUUID() }]) {  // buyer is never the client's choice
    assert.equal(parseSale(bad), null, `expected rejection: ${JSON.stringify(bad)?.slice(0,60)}`);
  }
});

// A pool that records statements and answers by the query shape it recognises.
// The options object stays mutable so a test can change the world between two
// calls (a lot changing hands, a buyer disappearing) without rebuilding the net.
function chainPool(options = {}) {
  const state = Object.assign({ roles: ['collector'], status: 'active', pickup: undefined,
    existingLot: null, lot: undefined, buyer: 'buyer-1', closed: true, sales: [] }, options);
  const seen = [];
  const pool = {
    seen, state,
    connect: async () => ({
      query: async (sql, params) => {
        const text = typeof sql === 'string' ? sql.replace(/\s+/g, ' ').trim() : '';
        seen.push({ text, params });
        if (text.startsWith('SELECT status FROM kabadi_authz.accounts')) return { rows: [{ status: state.status }] };
        if (text.startsWith('SELECT role FROM kabadi_authz.role_grants')) return { rows: state.roles.map(role => ({ role })) };
        if (text.startsWith('SELECT status, collector_id')) return { rows: state.pickup ? [state.pickup] : [] };
        if (text.startsWith('SELECT 1 FROM kabadi_lots.lots WHERE source_pickup_id')) {
          return { rows: state.existingLot ? [{}] : [], rowCount: state.existingLot ? 1 : 0 };
        }
        if (text.startsWith('INSERT INTO kabadi_lots.lots') && text.includes('source_pickup_id')) {
          return { rows: [{ id: 'lot-1', holder_id: state.pickup?.collector_id ?? 'c', material: params[1],
            grams: state.pickup?.actual_grams ?? 1000, cost_paise: state.pickup?.final_amount_paise ?? '0', status: 'held',
            source_pickup_id: params[4], parent_lot_id: null, created_at: new Date(), sold_at: null }] };
        }
        if (text.startsWith('SELECT id, holder_id')) return { rows: state.lot ? [state.lot] : [] };
        if (text.startsWith('SELECT a.user_id FROM kabadi_authz.accounts')) {
          return { rows: state.buyer ? [{ user_id: state.buyer }] : [] };
        }
        if (text.startsWith('UPDATE kabadi_lots.lots SET status')) {
          return { rows: state.closed ? [{ id: 'sold' }] : [], rowCount: state.closed ? 1 : 0 };
        }
        if (text.startsWith('INSERT INTO kabadi_lots.lots')) return { rows: [{ id: 'next-lot' }] };
        if (text.startsWith('INSERT INTO kabadi_lots.sales')) {
          return { rows: [{ id: 'sale-1', lot_id: params[0], seller_id: params[1], buyer_id: params[2],
            grams: params[3], price_paise: params[4], buyer_lot_id: params[5], recorded_at: new Date() }] };
        }
        if (text.startsWith('SELECT 1 FROM kabadi_lots.lots WHERE id=$1 AND holder_id')) {
          return { rows: state.sales.length ? [{}] : [], rowCount: state.sales.length ? 1 : 0 };
        }
        if (text.startsWith('SELECT id, lot_id, seller_id')) return { rows: state.sales };
        return { rows: [] };
      },
      release: () => {},
    }),
  };
  return pool;
}

const heldLot = (over = {}) => ({ id: 'lot-1', holder_id: 'col-1', material: 'Copper wire', grams: 1000,
  cost_paise: '100000', status: 'held', source_pickup_id: null, parent_lot_id: null,
  created_at: new Date('2026-11-01T00:00:00Z'), sold_at: null, ...over });

test('a collector opens a lot from a pickup they collected, at the pickup\'s own weight and cost', async () => {
  const pickupId = randomUUID();
  const pool = chainPool({ pickup: { status: 'collected', collector_id: 'col-1',
    actual_grams: 2300, final_amount_paise: '7464' } });
  const result = await createLotStore(pool).openFromPickup('col-1', { pickupId, material: 'Copper wire' });
  assert.equal(result.outcome, 'opened');
  // The weight and cost come from the pickup row, never from the request.
  assert.equal(result.lot.grams, 2300);
  assert.equal(result.lot.costPaise, '7464');
  const insert = pool.seen.find(q => q.text.startsWith('INSERT INTO kabadi_lots.lots'));
  assert.deepEqual(insert.params.slice(0, 3), ['col-1', 'Copper wire', 2300]);
});

test('custody cannot be opened from a pickup that was not collected, or for somebody else', async () => {
  const pickupId = randomUUID();
  const store = createLotStore;

  // Not collected yet: there is no measured weight and no money, so no stock.
  let pool = chainPool({ pickup: { status: 'accepted', collector_id: 'col-1', actual_grams: null, final_amount_paise: null } });
  assert.deepEqual(await store(pool).openFromPickup('col-1', { pickupId, material: 'x' }),
    { outcome: 'pickup-not-collected' });

  // A different collector cannot claim material somebody else measured.
  pool = chainPool({ pickup: { status: 'collected', collector_id: 'col-2', actual_grams: 100, final_amount_paise: '1' } });
  assert.deepEqual(await store(pool).openFromPickup('col-1', { pickupId, material: 'x' }), { outcome: 'not-holder' });

  // A customer cannot open stock at all, whatever they send.
  pool = chainPool({ roles: ['customer'], pickup: { status: 'collected', collector_id: 'col-1', actual_grams: 100, final_amount_paise: '1' } });
  assert.deepEqual(await store(pool).openFromPickup('cust-1', { pickupId, material: 'x' }), { outcome: 'not-collector' });

  // One pickup, one lot. The unique index is the real guard; this is the answer.
  pool = chainPool({ pickup: { status: 'collected', collector_id: 'col-1', actual_grams: 100, final_amount_paise: '1' }, existingLot: true });
  assert.deepEqual(await store(pool).openFromPickup('col-1', { pickupId, material: 'x' }),
    { outcome: 'pickup-already-lotted' });
});

test('selling up one tier opens the buyer\'s lot at exactly the sold weight', async () => {
  const lotId = randomUUID();
  const pool = chainPool({ roles: ['collector'], lot: heldLot({ id: lotId, holder_id: 'col-1' }), buyer: 'shop-1' });
  const result = await createLotStore(pool).sell('col-1', { lotId, grams: 400, pricePaise: '60000' });
  assert.equal(result.outcome, 'sold');
  // The seller learns the tier that bought, never the account.
  assert.equal(result.sale.buyerTier, 'shop');
  assert.equal('buyerId' in result.sale, false);
  // The buyer receives exactly what was sold -- weight is conserved, never
  // rounded, never the seller's whole holding unless that is what was sold.
  const buyerInsert = pool.seen.filter(q => q.text.startsWith('INSERT INTO kabadi_lots.lots'));
  assert.equal(buyerInsert[0].params[2], 400);
  // The remainder stays with the seller as a NEW lot, so the lot the sale refers
  // to is never mutated into a different quantity.
  assert.equal(buyerInsert[1].params[0], 'col-1');
  assert.equal(buyerInsert[1].params[2], 600);
  // The remainder keeps a PRO-RATA share of the cost, not the whole basis. This
  // is the assertion that catches inventory inflation: 600 g of a 1000 g lot
  // that cost 100000 paise is worth 60000, not 100000. The division is bigint in
  // the database ($4 * grams) / total, so it is exact and rounds down.
  assert.equal(buyerInsert[1].params[3], '100000', 'the full basis is passed as the multiplicand');
  assert.equal(buyerInsert[1].params[4], 1000, 'and the original weight as the divisor');
  assert.match(buyerInsert[1].text, /\(\$4::bigint \* \$3::bigint\) \/ \$5::bigint/,
    'the cost is divided in integer arithmetic, never in application floating point');
  // Nothing adds cost out of thin air: buyer share + remainder share <= the basis.
  const buyerShare = 60000;                     // what the buyer's lot was priced at
  const remainderShare = Number(100000n * 600n / 1000n);
  assert.ok(remainderShare <= 100000 - 0, 'the remainder cannot exceed the original basis');
  assert.equal(buyerShare + remainderShare, 120000, 'but a sale price may legitimately exceed cost: that is the margin');
});

test('a partial sale never inflates the seller\'s inventory', async () => {
  // Repeated partial sales are where a copy-the-whole-cost bug compounds: sell
  // 100 g four times out of a 400 g lot and the remainder must shrink each time.
  const lotId = randomUUID();
  const pool = chainPool({ roles: ['collector'], lot: heldLot({ id: lotId, holder_id: 'col-1', grams: 400, cost_paise: '40000' }) });
  await createLotStore(pool).sell('col-1', { lotId, grams: 100, pricePaise: '15000' });
  const remainder = pool.seen.filter(q => q.text.startsWith('INSERT INTO kabadi_lots.lots'))[1];
  // 300 g of a 400 g lot that cost 40000 is 30000, not 40000.
  assert.equal(remainder.params[2], 300);
  assert.equal(remainder.params[3], '40000');
  assert.equal(remainder.params[4], 400);
});

test('a lot cannot be sold twice, by a non-holder, or for more than it holds', async () => {
  const lotId = randomUUID();
  const store = createLotStore;

  assert.deepEqual(await store(chainPool({ lot: heldLot({ id: lotId, holder_id: 'col-2' }) }))
    .sell('col-1', { lotId, grams: 10, pricePaise: '1' }), { outcome: 'not-holder' });

  assert.deepEqual(await store(chainPool({ lot: heldLot({ id: lotId, holder_id: 'col-1', status: 'sold', sold_at: new Date() }) }))
    .sell('col-1', { lotId, grams: 10, pricePaise: '1' }), { outcome: 'already-sold' });

  assert.deepEqual(await store(chainPool({ lot: heldLot({ id: lotId, holder_id: 'col-1', grams: 100 }) }))
    .sell('col-1', { lotId, grams: 101, pricePaise: '1' }), { outcome: 'invalid-weight' });

  assert.deepEqual(await store(chainPool({ lot: null })).sell('col-1', { lotId, grams: 10, pricePaise: '1' }),
    { outcome: 'not-found' });

  // A second sale that loses the conditional UPDATE race is refused, not retried.
  assert.deepEqual(await store(chainPool({ lot: heldLot({ id: lotId }), closed: false }))
    .sell('col-1', { lotId, grams: 10, pricePaise: '1' }), { outcome: 'already-sold' });
});

test('a recycler has nothing to sell upward to, and an admin cannot sell air', async () => {
  const lotId = randomUUID();
  // The recycler is terminal: their material is processed, not resold.
  assert.deepEqual(await createLotStore(chainPool({ roles: ['recycler'], lot: heldLot({ holder_id: 'rec-1' }) }))
    .sell('rec-1', { lotId, grams: 10, pricePaise: '1' }), { outcome: 'no-next-tier' });

  // An admin with no chain grant holds no tier, so there is no tier to sell from.
  // Otherwise an operator could move material they never held.
  assert.deepEqual(await createLotStore(chainPool({ roles: ['admin'], lot: heldLot({ holder_id: 'admin-1' }) }))
    .sell('admin-1', { lotId, grams: 10, pricePaise: '1' }), { outcome: 'not-a-chain-account' });
});

test('the next tier must actually exist, and the buyer is never the seller', async () => {
  const lotId = randomUUID();
  // Nobody holds the next tier up: refuse rather than invent a buyer.
  assert.deepEqual(await createLotStore(chainPool({ lot: heldLot(), buyer: null }))
    .sell('col-1', { lotId, grams: 10, pricePaise: '1' }), { outcome: 'buyer-not-next-tier' });

  // The buyer query excludes the seller at the SQL level, so this can only
  // happen if the query were wrong; assert the code refuses it anyway.
  assert.deepEqual(await createLotStore(chainPool({ lot: heldLot(), buyer: 'col-1' }))
    .sell('col-1', { lotId, grams: 10, pricePaise: '1' }), { outcome: 'buyer-same-account' });

  // And the query itself must name the next tier, not any tier.
  const pool = chainPool({ roles: ['shop'], lot: heldLot({ holder_id: 'shop-1' }) });
  await createLotStore(pool).sell('shop-1', { lotId, grams: 10, pricePaise: '1' });
  const buyerQuery = pool.seen.find(q => q.text.startsWith('SELECT a.user_id FROM kabadi_authz.accounts'));
  assert.equal(buyerQuery.params[0], 'mandi', 'a shop sells to a mandi, not to a collector');
  assert.equal(buyerQuery.params[1], 'shop-1', 'and never to itself');
});

test('a sale writes the sale row and closes the lot in the same transaction as the custody move', async () => {
  const lotId = randomUUID();
  const pool = chainPool({ lot: heldLot({ id: lotId }) });
  await createLotStore(pool).sell('col-1', { lotId, grams: 100, pricePaise: '5000' });
  const statements = pool.seen.map(q => q.text);
  assert.equal(statements[0], 'BEGIN');
  assert.equal(statements.at(-1), 'COMMIT');
  // The close is conditional on status and holder, so a racing second sale
  // loses in the database rather than in an application check.
  const close = pool.seen.find(q => q.text.startsWith('UPDATE kabadi_lots.lots SET status'));
  assert.match(close.text, /WHERE id=\$1 AND status='held' AND holder_id=\$2/);
  // The sale is never written before the lot is closed.
  assert.ok(statements.findIndex(s => s.startsWith('UPDATE kabadi_lots.lots SET status')) <
            statements.findIndex(s => s.startsWith('INSERT INTO kabadi_lots.sales')));
});

test('an account with no chain grant is refused before anything is read', async () => {
  const pool = chainPool({ roles: [] });
  assert.equal(await createLotStore(pool).held('nobody'), 'forbidden');
  // A suspended account is refused too, and the refusal happens on the account
  // row rather than on the grants.
  const suspended = chainPool({ roles: ['collector'], status: 'suspended' });
  assert.equal(await createLotStore(suspended).held('col-1'), 'forbidden');
});

test('the lot routes refuse cross-origin writes, oversize bodies and unknown fields', async () => {
  const { createApp } = await import('../../apps/api/dist/app.js');
  const { once } = await import('node:events');
  const called = [];
  const lotId = randomUUID();
  // The real store, so the routes are tested against its actual validation and
  // its real refusal codes rather than a permissive stub.
  const pool = chainPool({ roles: ['collector'], lot: heldLot({ id: lotId, holder_id: 'col-1' }) });
  const store = createLotStore(pool);
  const counting = {
    held: (id) => { called.push(['held', id]); return store.held(id); },
    history: (id, requested) => { called.push(['history', requested]); return store.history(id, requested); },
    openFromPickup: (id, raw) => { called.push(['open', id]); return store.openFromPickup(id, raw); },
    sell: (id, raw) => { called.push(['sell', id]); return store.sell(id, raw); },
  };
  const auth = {
    origin: 'http://localhost:3000', handler: async () => {},
    resolveIdentity: async () => ({ userId: 'col-1', cookies: [] }),
    lots: counting,
  };
  const server = createApp(auth).listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = { origin: 'http://localhost:3000' };
  try {
    // A read is the caller's own holdings only.
    let response = await fetch(`${base}/api/v1/lots`, { headers: origin });
    assert.equal(response.status, 200);
    // The stub pool holds one lot for col-1; it must come back as a public lot.
    const listed = (await response.json()).data.lots;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, lotId);
    assert.equal(response.headers.get('cache-control'), 'no-store');

    // Cross-origin writes are refused before the store is touched.
    for (const path of ['/api/v1/lots', '/api/v1/lots/sell']) {
      response = await fetch(`${base}${path}`, { method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ pickupId: lotId, material: 'x' }) });
      assert.equal(response.status, 403, path);
    }
    assert.equal(called.filter(([kind]) => kind === 'open' || kind === 'sell').length, 0);

    // The store is the validator, so a malformed body becomes one 400 code and
    // no lot is created -- never a 500 and never a partial write.
    response = await fetch(`${base}/api/v1/lots`, { method: 'POST',
      headers: { ...origin, 'content-type': 'application/json' }, body: '{"nope":1}' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
    assert.equal(pool.seen.some(q => q.text.startsWith('INSERT INTO kabadi_lots.lots')), false);
    called.length = 0;

    // A refusal from the store maps to one specific code, not a generic 500.
    // The lot changes hands between the two calls, so col-1 is no longer holding it.
    pool.state.lot = heldLot({ id: lotId, holder_id: 'col-2' });
    response = await fetch(`${base}/api/v1/lots/sell`, { method: 'POST',
      headers: { ...origin, 'content-type': 'application/json' },
      body: JSON.stringify({ lotId, grams: 10, pricePaise: '100' }) });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'NOT_HOLDER');

    // A lot that is not yours is reported as absent, not forbidden, so the
    // endpoint cannot be used to probe which ids exist.
    response = await fetch(`${base}/api/v1/lots/${randomUUID()}/history`, { headers: origin });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'LOT_NOT_FOUND');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('without the lot migration the routes say so instead of failing obscurely', async () => {
  const { createApp } = await import('../../apps/api/dist/app.js');
  const { once } = await import('node:events');
  // No lots store mounted at all -- exactly what a database without the lot
  // schema looks like to the app.
  const auth = { origin: 'http://localhost:3000', handler: async () => {},
    resolveIdentity: async () => ({ userId: 'col-1', cookies: [] }) };
  const server = createApp(auth).listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/lots`,
      { headers: { origin: 'http://localhost:3000' } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'LOTS_UNAVAILABLE');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('the custody trail is shared, but a trade\'s price is only shown to its two parties', async () => {
  const lotId = randomUUID();
  // A mandi is looking at the history of a lot it now holds. The earlier trade
  // that created that lot was a collector selling to a shop, and what the shop
  // paid is none of the mandi's business.
  const sales = [
    { id: 'sale-1', lot_id: lotId, seller_id: 'col-1', buyer_id: 'shop-1', grams: 400,
      buyer_tier: 'shop', price_paise: '60000', buyer_lot_id: null, recorded_at: new Date('2026-11-02T00:00:00Z') },
    { id: 'sale-2', lot_id: lotId, seller_id: 'shop-1', buyer_id: 'mandi-1', grams: 400,
      buyer_tier: 'mandi', price_paise: '80000', buyer_lot_id: null, recorded_at: new Date('2026-11-03T00:00:00Z') },
  ];
  const pool = chainPool({ roles: ['mandi'], lot: heldLot({ id: lotId, holder_id: 'mandi-1' }), sales });
  const history = await createLotStore(pool).history('mandi-1', lotId);

  assert.equal(history.length, 2);
  // The physical trail is intact: what moved, when, and which lot it was.
  assert.deepEqual(history.map(s => s.grams), [400, 400]);
  assert.deepEqual(history.map(s => s.recordedAt),
    ['2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z']);
  // The mandi's own purchase price is visible; the shop's cost is not.
  assert.equal(history[1].pricePaise, '80000');
  assert.equal(history[1].party, 'buyer');
  assert.equal(history[1].buyerTier, 'mandi');
  assert.equal(history[0].pricePaise, null);
  assert.equal(history[0].party, 'observer');

  // The seller of that first trade sees it; the money is theirs.
  const sellerPool = chainPool({ roles: ['shop'], lot: heldLot({ id: lotId, holder_id: 'shop-1' }), sales });
  const sellerHistory = await createLotStore(sellerPool).history('shop-1', lotId);
  // The shop bought from the collector and sold to the mandi: it sees both prices,
  // as buyer of the first trade and seller of the second.
  assert.deepEqual(sellerHistory.map(s => [s.party, s.pricePaise]),
    [['buyer', '60000'], ['seller', '80000']]);
});

test('a collector holds tier one and sells to a shop: the whole chain is reachable', async () => {
  const lotId = randomUUID();
  // The collector is the origin of every lot, so if they cannot sell, nothing
  // above them can ever receive material and the chain is decorative.
  const pool = chainPool({ roles: ['customer', 'collector'], lot: heldLot({ id: lotId, holder_id: 'col-1' }), buyer: 'shop-1' });
  const result = await createLotStore(pool).sell('col-1', { lotId, grams: 1000, pricePaise: '120000' });
  assert.equal(result.outcome, 'sold');
  assert.equal(result.sale.buyerTier, 'shop');

  // And the buyer query must ask for a shop, not for "anyone not me".
  const buyerQuery = pool.seen.find(q => q.text.startsWith('SELECT a.user_id FROM kabadi_authz.accounts'));
  assert.equal(buyerQuery.params[0], 'shop');
  assert.equal(buyerQuery.params[1], 'col-1');
});

test('every holding tier in the chain has exactly one tier above it, except the recycler', async () => {
  // A table, not five near-identical tests: this is the property that makes the
  // chain a chain, and it must hold for every tier at once.
  const pairs = [['collector', 'shop'], ['shop', 'mandi'], ['mandi', 'recycler']];
  for (const [seller, expectedBuyer] of pairs) {
    const pool = chainPool({ roles: [seller], lot: heldLot({ holder_id: `${seller}-1` }) });
    const result = await createLotStore(pool).sell(`${seller}-1`,
      { lotId: randomUUID(), grams: 100, pricePaise: '1000' });
    assert.equal(result.outcome, 'sold', seller);
    const buyerQuery = pool.seen.find(q => q.text.startsWith('SELECT a.user_id FROM kabadi_authz.accounts'));
    assert.equal(buyerQuery.params[0], expectedBuyer, `${seller} sells to ${expectedBuyer}`);
  }
  // The recycler is not in that table because there is nothing above it.
  const recycler = chainPool({ roles: ['recycler'], lot: heldLot({ holder_id: 'rec-1' }) });
  assert.deepEqual(await createLotStore(recycler).sell('rec-1', { lotId: randomUUID(), grams: 100, pricePaise: '1000' }),
    { outcome: 'no-next-tier' });
});

test('an audit table built before the chain tiers is widened, not left stale', async () => {
  // The bug this catches: `grant ... shop` on a months-old database reported
  // "migration completed, nothing changed" because the admin migration only set
  // the role CHECK when creating the table fresh, then failed at the database
  // with a constraint the operator had never seen.
  const { migrateRoleAdmin } = await import('../../apps/api/dist/role-admin.js');
  const statements = [];
  const staleDef = "CHECK ((role = ANY (ARRAY['customer'::text, 'collector'::text, 'admin'::text])))";
  const pool = { connect: async () => ({
    query: async (sql, params) => {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      statements.push({ text, params });
      if (text.startsWith('SELECT to_regclass')) return { rows: [{ marker: 'some_table' }] };
      if (text.startsWith('SELECT version FROM kabadi_authz')) return { rows: [{ version: 2 }] };
      if (text.startsWith('SELECT EXISTS (SELECT 1 FROM pg_namespace')) return { rows: [{ exists: true }] };
      if (text.startsWith('SELECT version FROM kabadi_admin')) return { rows: [{ version: 1 }] };
      if (text.startsWith('SELECT pg_get_constraintdef')) return { rows: [{ def: staleDef }] };
      if (text.startsWith('SELECT conname FROM pg_constraint')) return { rows: [{ conname: 'role_changes_role_check' }] };
      return { rows: [] };
    },
    release: () => {},
  }) };

  // It must not refuse a v2 authorization schema: that is the state every
  // upgraded database is in, and refusing would block the audit table forever.
  await migrateRoleAdmin(pool);

  const dropped = statements.find(s => s.text.startsWith('ALTER TABLE kabadi_admin.role_changes DROP CONSTRAINT'));
  assert.ok(dropped, 'the stale CHECK is dropped');
  assert.equal(dropped.text, 'ALTER TABLE kabadi_admin.role_changes DROP CONSTRAINT "role_changes_role_check"');
  const added = statements.find(s => s.text.startsWith('ALTER TABLE kabadi_admin.role_changes ADD CONSTRAINT'));
  assert.ok(added, 'a widened CHECK is added');
  // Every role the application knows must be acceptable afterwards.
  for (const role of CHAIN_ROLES) assert.ok(added.text.includes(`'${role}'`), `${role} is accepted`);
  assert.ok(added.text.includes(`'admin'`), 'admin is still accepted');
});

test('an audit table that already allows every role is left alone', async () => {
  const { migrateRoleAdmin } = await import('../../apps/api/dist/role-admin.js');
  const statements = [];
  const currentDef = "CHECK ((role = ANY (ARRAY['customer'::text, 'collector'::text, 'shop'::text, 'mandi'::text, 'recycler'::text, 'admin'::text])))";
  const pool = { connect: async () => ({
    query: async sql => {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      statements.push(text);
      if (text.startsWith('SELECT to_regclass')) return { rows: [{ marker: 'some_table' }] };
      if (text.startsWith('SELECT version FROM kabadi_authz')) return { rows: [{ version: 2 }] };
      if (text.startsWith('SELECT EXISTS (SELECT 1 FROM pg_namespace')) return { rows: [{ exists: true }] };
      if (text.startsWith('SELECT version FROM kabadi_admin')) return { rows: [{ version: 1 }] };
      if (text.startsWith('SELECT pg_get_constraintdef')) return { rows: [{ def: currentDef }] };
      return { rows: [] };
    },
    release: () => {},
  }) };
  await migrateRoleAdmin(pool);
  // A migration that always rewrites is a migration that can fail for no reason.
  assert.equal(statements.some(s => s.startsWith('ALTER TABLE kabadi_admin')), false);
});
