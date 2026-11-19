import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { parsePickup } from '../../apps/api/dist/pickups.js';
import { createApp } from '../../apps/api/dist/app.js';

const categoryId = randomUUID();
const valid = {requestKey:randomUUID(), categoryId, estimatedGrams:2500};
const estimate = {categoryId, categoryName:'Paper', rateId:randomUUID(), paisePerKg:3245, amountPaise:'8113'};

test('pickup input requires a real category id and rejects any client pricing', () => {
  assert.deepEqual(parsePickup(valid), {...valid, requestKey:valid.requestKey.toLowerCase(), categoryId:categoryId.toLowerCase()});
  for (const input of [
    null, [], {},
    {...valid, userId:'other'},                       // identity is never accepted
    {...valid, estimatedGrams:0},
    {...valid, estimatedGrams:1.5},
    {...valid, estimatedGrams:10000001},
    {...valid, requestKey:'bad'},
    {...valid, categoryId:'bad'},
    {...valid, categoryId:randomUUID().replace('-4','-1')}, // not a v4 UUID
    {...valid, material:'Paper'},                     // legacy field must not be smuggled in
    // Client-supplied pricing must never be accepted.
    {...valid, paisePerKg:1},
    {...valid, amountPaise:'1'},
    {...valid, rateId:randomUUID()},
  ]) assert.equal(parsePickup(input), null, `expected rejection: ${JSON.stringify(input)}`);
});

test('pickup API uses session identity, returns the server estimate, and sanitizes failures', async () => {
  let identity = {userId:'owner', cookies:['refresh=value; HttpOnly']}, called = [], outcome = {outcome:'created', estimate};
  const auth = {origin:'http://localhost:3000', handler:async()=>{}, resolveIdentity:async()=>identity,
    pickups:{create:async (id, v)=>{called.push([id,v]); return outcome;}, list:async id=>{called.push(id); return [];}}};
  const server = createApp(auth).listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/v1/customer/pickups`;
    const post = (input, origin='http://localhost:3000') => fetch(url, {method:'POST',headers:{origin,'content-type':'application/json','x-user-id':'forged'},body:JSON.stringify(input)});
    assert.equal((await post(valid,'https://evil.example')).status,403);
    assert.equal((await post({...valid,userId:'other'})).status,400); assert.equal(called.length,0);
    // A client-supplied price is rejected outright, not silently ignored.
    assert.equal((await post({...valid, paisePerKg:1})).status,400);
    assert.equal(called.length,0);

    let response = await post(valid); assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(response.headers.getSetCookie(), ['refresh=value; HttpOnly']);
    const body = await response.json();
    assert.deepEqual(body, {data:{created:true, estimate}});
    assert.deepEqual(called.pop(),['owner',{...valid, requestKey:valid.requestKey.toLowerCase(), categoryId:categoryId.toLowerCase()}]);

    outcome = {outcome:'replayed', estimate};
    response = await post(valid); assert.equal((await response.json()).data.created, false, 'a replay is not a new creation');

    for (const [v,status,code] of [
      [{outcome:'missing-profile'},409,'PROFILE_REQUIRED'],
      [{outcome:'conflict'},409,'REQUEST_CONFLICT'],
      [{outcome:'unknown-category'},409,'UNKNOWN_CATEGORY'],
      [{outcome:'no-rate'},409,'NO_RATE'],
      ['forbidden',403,'FORBIDDEN'],
    ]) {
      outcome=v; response=await post(valid);
      assert.equal(response.status,status); assert.equal((await response.json()).error.code,code);
    }

    // A malformed estimate from storage must fail closed, never be echoed.
    for (const bad of [
      {...estimate, amountPaise:'-1'},
      {...estimate, amountPaise:'1e5'},
      {...estimate, paisePerKg:-1},
      {...estimate, rateId:'bad'},
      {...estimate, categoryName:''},
      {...estimate, categoryName:'x'.repeat(101)},
    ]) {
      outcome = {outcome:'created', estimate:bad};
      response = await post(valid);
      assert.equal(response.status,503,`expected fail-closed for ${JSON.stringify(bad)}`);
      assert.ok(!(await response.text()).includes('Paise'));
    }

    identity={userId:null,cookies:[]}; assert.equal((await fetch(url)).status,401); assert.equal((await post(valid)).status,401);
    identity={userId:'owner',cookies:[]}; auth.pickups.list=async()=>{throw Error('secret');};
    response=await fetch(url); assert.equal(response.status,503); assert.ok(!(await response.text()).includes('secret'));
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('pickup list separates priced requests from legacy free text and rejects malformed rows', async () => {
  const id = randomUUID();
  const address = {name:'Sample', addressLine:'12 Example', city:'Ludhiana', state:'Punjab', postalCode:'141001'};
  const empty = { actualGrams:null, finalRateId:null, finalPaisePerKg:null, finalAmountPaise:null, collectedAt:null,
    cancelledAt:null, cancellationReason:null, releasedAt:null, dispute:null, payout:null };
  const priced = { id, status:'requested', createdAt:'2026-11-18T17:00:00.000Z', address, estimatedGrams:500,
    material:null, categoryId, categoryName:'Paper', rateId:randomUUID(), paisePerKg:3245, amountPaise:'1623', ...empty };
  const legacy = { ...priced, categoryId:null, categoryName:null, rateId:null, paisePerKg:null, amountPaise:null, material:'Old paper' };
  let rows = [priced, legacy];
  const auth = {origin:'http://localhost:3000', handler:async()=>{}, resolveIdentity:async()=>({userId:'owner',cookies:[]}),
    pickups:{create:async()=>({outcome:'conflict'}), list:async()=>rows}};
  const server = createApp(auth).listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/v1/customer/pickups`;
    let response = await fetch(url);
    assert.equal(response.status,200);
    {
      const body = await response.json();
      // Every list response now carries the notification descriptor; the rows
      // themselves are unchanged.
      assert.equal(body.data.notifications.configured, false);
      assert.equal(body.data.notifications.delivery, 'none');
      assert.deepEqual(body.data.pickups, [priced, legacy]);
    }
    // A half-priced row is inconsistent and must fail closed.
    for (const bad of [
      {...priced, amountPaise:null},
      {...priced, rateId:null},
      {...priced, paisePerKg:null},
      {...legacy, material:null},
      {...priced, createdAt:'not-a-date'},
      {...priced, estimatedGrams:0},
      {...priced, id:'bad'},
    ]) {
      rows=[bad]; response = await fetch(url);
      assert.equal(response.status,503,`expected failure for ${JSON.stringify(bad).slice(0,120)}`);
    }
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

// ---- Collector surface ---------------------------------------------------
// The browser never supplies its own identity, price or collector id, so every
// check below is about what the session, the store and the state allow.
test('collector routes derive the actor from the session and map every state outcome', async () => {
  const requestId = randomUUID();
  const address = {name:'Sample', addressLine:'12 Example', city:'Ludhiana', state:'Punjab', postalCode:'141001'};
  const openRow = { id:requestId, status:'requested', createdAt:'2026-11-18T17:00:00.000Z', address, estimatedGrams:2500,
    material:null, categoryId, categoryName:'Paper', rateId:randomUUID(), paisePerKg:3245, amountPaise:'8113',
    actualGrams:null, finalRateId:null, finalPaisePerKg:null, finalAmountPaise:null, collectedAt:null,
    cancelledAt:null, cancellationReason:null, releasedAt:null, dispute:null, payout:null };
  const called = [];
  let outcome={outcome:'accepted'}, rows=[openRow];
  const collector = {
    open:async id=>{called.push(['open',id]); return rows;},
    mine:async id=>{called.push(['mine',id]); return rows;},
    accept:async (id,rid)=>{called.push(['accept',id,rid]); return outcome;},
    collect:async (id,rid,g)=>{called.push(['collect',id,rid,g]); return outcome;},
  };
  const auth = {origin:'http://localhost:3000', handler:async()=>{}, resolveIdentity:async()=>({userId:'collector-1',cookies:['refresh=1; HttpOnly']}),
    pickups:{create:async()=>({outcome:'conflict'}), list:async()=>[]}, collector};
  const server = createApp(auth).listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/v1/collector/pickups`;
    const post = (path, body, headers={}) => fetch(`${base}/${path}`, {method:'POST',
      headers:{origin:'http://localhost:3000','content-type':'application/json',...headers},
      body: body === undefined ? undefined : JSON.stringify(body)});

    // Reads: view is explicit, never inferred.
    let response = await fetch(`${base}?view=open`);
    assert.equal(response.status,200); assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(await response.json(), {data:{pickups:[openRow]}});
    assert.deepEqual(called.pop(), ['open','collector-1']);
    response = await fetch(`${base}?view=mine`); assert.equal(response.status,200);
    assert.deepEqual(called.pop(), ['mine','collector-1']);
    for (const q of ['', '?view=all', '?view=open&view=mine']) {
      assert.equal((await fetch(`${base}${q}`)).status,400,`view ${q} must be rejected`);
    }

    // Accept: empty object only, exact origin, session identity.
    response = await post(`${requestId}/accept`, {});
    assert.equal(response.status,200); assert.deepEqual(await response.json(), {data:{accepted:true}});
    assert.deepEqual(called.pop(), ['accept','collector-1',requestId]);
    assert.equal((await post(`${requestId}/accept`, {collectorId:'someone-else'})).status,400);
    assert.equal((await post(`${requestId}/accept`, {}, {origin:'https://evil.example'})).status,403);
    assert.equal((await post(`${requestId}/accept`, {}, {'content-type':'text/plain'})).status,415);
    assert.equal((await post('not-a-uuid/accept', {})).status,400);

    // Collect: actualGrams only, and the settlement is what came back.
    const settlement = {actualGrams:2300, finalPaisePerKg:3300, finalAmountPaise:'7590', finalRateId:randomUUID()};
    outcome = {outcome:'collected', ...settlement};
    response = await post(`${requestId}/collect`, {actualGrams:2300});
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(), {data:{collected:true, ...settlement}});
    assert.deepEqual(called.pop(), ['collect','collector-1',requestId,2300]);
    for (const body of [{}, {actualGrams:'2300'}, {actualGrams:0}, {actualGrams:1.5}, {actualGrams:2300, paisePerKg:1}]) {
      assert.equal((await post(`${requestId}/collect`, body)).status,400,`expected rejection ${JSON.stringify(body)}`);
    }

    // Every "no" the store can answer keeps its own code so the app can explain it.
    for (const [v,status,code] of [
      [{outcome:'not-found'},404,'REQUEST_NOT_FOUND'],
      [{outcome:'already-accepted'},409,'ALREADY_ACCEPTED'],
      [{outcome:'not-accepted'},409,'NOT_ACCEPTED'],
      [{outcome:'already-collected'},409,'ALREADY_COLLECTED'],
      [{outcome:'no-rate'},409,'NO_RATE'],
      [{outcome:'legacy-request'},409,'LEGACY_REQUEST'],
    ]) {
      outcome=v; response=await post(`${requestId}/accept`, {});
      assert.equal(response.status,status); assert.equal((await response.json()).error.code,code);
    }
    // A collector with no grant is refused, and a thrown store error is sanitized.
    outcome='forbidden'; assert.equal((await post(`${requestId}/accept`, {})).status,403);
    collector.open=async()=>{throw Error('connection string leaked');};
    response=await fetch(`${base}?view=open`);
    assert.equal(response.status,503); assert.ok(!(await response.text()).includes('leaked'));

    // No collector store mounted at all: unavailable, never an open door.
    const bare = createApp({...auth, collector:undefined}).listen(0,'127.0.0.1'); await once(bare,'listening');
    try {
      const bareBase = `http://127.0.0.1:${bare.address().port}/api/v1/collector/pickups`;
      assert.equal((await fetch(`${bareBase}?view=open`)).status,503);
      assert.equal((await fetch(`${bareBase}/${requestId}/accept`, {method:'POST',
        headers:{origin:'http://localhost:3000','content-type':'application/json'}, body:'{}'})).status,503);
    } finally { await new Promise(resolve=>bare.close(resolve)); }
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('collector list fails closed on a malformed or unsettled row', async () => {
  const address = {name:'Sample', addressLine:'12 Example', city:'Ludhiana', state:'Punjab', postalCode:'141001'};
  const base = { id:randomUUID(), status:'requested', createdAt:'2026-11-18T17:00:00.000Z', address, estimatedGrams:2500,
    material:null, categoryId, categoryName:'Paper', rateId:randomUUID(), paisePerKg:3245, amountPaise:'8113',
    actualGrams:null, finalRateId:null, finalPaisePerKg:null, finalAmountPaise:null, collectedAt:null,
    cancelledAt:null, cancellationReason:null, releasedAt:null, dispute:null, payout:null };
  const collected = {...base, status:'collected', actualGrams:2300, finalRateId:randomUUID(), finalPaisePerKg:3300,
    finalAmountPaise:'7590', collectedAt:'2026-11-20T10:00:00.000Z'};
  let rows=[collected];
  const auth = {origin:'http://localhost:3000', handler:async()=>{}, resolveIdentity:async()=>({userId:'collector-1',cookies:[]}),
    pickups:{create:async()=>({outcome:'conflict'}), list:async()=>[]},
    collector:{open:async()=>rows, mine:async()=>rows, accept:async()=>({outcome:'accepted'}), collect:async()=>({outcome:'accepted'})}};
  const server = createApp(auth).listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/v1/collector/pickups?view=open`;
    let response = await fetch(url);
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(), {data:{pickups:[collected]}});
    for (const bad of [
      {...collected, actualGrams:null},              // collected without a weight
      {...collected, finalAmountPaise:null},         // collected without an amount
      {...collected, finalRateId:'bad'},
      {...collected, finalPaisePerKg:null},
      {...collected, collectedAt:null},
      {...base, categoryId:null},                    // legacy rows are never offered to collectors
      {...base, amountPaise:null},
      {...base, status:'unknown'},
      {...base, id:'bad'},
    ]) {
      rows=[bad]; response=await fetch(url);
      assert.equal(response.status,503,`expected fail-closed for ${JSON.stringify(bad).slice(0,100)}`);
    }
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

// ---- Schema migration ----------------------------------------------------
// A recording fake client asserts the SQL the migration emits, so the v1 -> v3
// chain is checked without a live database.
test('pickup migration walks v1 to v6 in one run and reports the real starting version', async () => {
  const { migratePickups } = await import('../../apps/api/dist/pickups.js');
  const statements = [];
  const V3 = ['collector_id', 'accepted_at', 'collected_at', 'actual_grams',
    'final_rate_id', 'final_paise_per_kg', 'final_amount_paise',
    'cancelled_at', 'cancellation_reason', 'released_at',
    'dispute_status', 'dispute_reason', 'dispute_raised_at', 'dispute_resolved_at'];
  const PAYOUT = ['request_id', 'collector_id', 'amount_paise', 'method', 'paid_at', 'recorded_by'];
  // `columns` defaults to a table that really is at the claimed version, so the
  // verification pass is exercised rather than bypassed.
  // Any successful upgrade ends at v3, so the default fake models that end state;
  // the damaged case below overrides it explicitly.
  function fakePool(version, columns = version >= 1 ? V3 : []) {
    return { connect: async () => ({
      query: async (sql, params) => {
        statements.push(typeof sql === 'string' ? sql.replace(/\s+/g, ' ').trim() : sql);
        if (sql.includes('pg_namespace')) return { rows: [{ exists: true }] };
        if (sql.includes('to_regclass')) return { rows: [{ marker: 'kabadi_pickup.schema_version' }] };
        // Prerequisite schemas (authz, customer, catalog) are all at version 1.
        if (/^SELECT version FROM kabadi_(authz|customer|catalog)\.schema_version$/.test(sql)) return { rows: [{ version: 1 }] };
        if (sql.startsWith('SELECT version FROM kabadi_pickup.schema_version')) return { rows: [{ version }] };
        if (sql.includes('information_schema.columns')) {
          const wanted = new Set(params?.[0] ?? []);
          // The request table probe passes only request columns; the payout probe
          // passes only payout columns. Model each with its own list.
          const pool = wanted.has('request_id') ? PAYOUT : columns;
          return { rows: pool.filter(name => wanted.has(name)).map(name => ({ column_name: name })) };
        }
        if (sql.includes('SELECT count(*)')) return { rows: [{ legacy: '1', total: '2' }] };
        return { rows: [] };
      },
      release: () => {},
    }) };
  }

  const report = await migratePickups(fakePool(1));
  assert.deepEqual(report, { action: 'upgraded', schemaVersion: 6, fromVersion: 1, legacyRequests: 1 });
  const all = statements.join('\n');
  // Both upgrade steps ran, in order, and each pinned its own version.
  assert.ok(all.indexOf('SET version = 2') < all.indexOf('ADD COLUMN collector_id'), 'v2 upgrade precedes v3');
  assert.ok(all.includes("ADD CONSTRAINT requests_status_check CHECK (status IN ('requested','accepted','collected'))"));
  assert.ok(all.includes('ADD COLUMN actual_grams integer CHECK (actual_grams BETWEEN 1 AND 10000000)'));
  assert.ok(all.includes('ADD CONSTRAINT pickup_lifecycle CHECK'));
  assert.ok(all.includes('CREATE INDEX pickup_open'));
  assert.ok(all.includes('CREATE INDEX pickup_collector'));
  assert.ok(all.includes('SET version = 3'));
  // The cancellation step runs last and adds its own columns and checks.
  assert.ok(all.indexOf('SET version = 3') < all.indexOf('ADD COLUMN cancelled_at'), 'v3 precedes v4');
  assert.ok(all.includes("ADD CONSTRAINT requests_status_check CHECK (status IN ('requested','accepted','collected','cancelled'))"));
  assert.ok(all.includes('ADD CONSTRAINT pickup_cancel_reason CHECK'));
  assert.ok(all.includes('SET version = 4'));
  assert.ok(all.indexOf('SET version = 4') < all.indexOf('ADD COLUMN dispute_status'), 'v4 precedes v5');
  assert.ok(all.includes('ADD CONSTRAINT pickup_dispute_shape CHECK'));
  assert.ok(all.includes('SET version = 5'));
  // The payout ledger is created last, in its own table.
  assert.ok(all.indexOf('SET version = 5') < all.indexOf('CREATE TABLE IF NOT EXISTS kabadi_pickup.payouts'));
  assert.ok(all.includes('SET version = 6'));
  // Existing rows are never rewritten or deleted by the upgrade.
  assert.ok(!/DELETE FROM kabadi_pickup\.requests/i.test(all));
  assert.ok(!/UPDATE kabadi_pickup\.requests SET (material|status)/i.test(all));

  // A v2 database takes the last two steps and stays 'upgraded'.
  statements.length = 0;
  assert.deepEqual(await migratePickups(fakePool(2)), { action: 'upgraded', schemaVersion: 6, fromVersion: 2, legacyRequests: 1 });
  const v2only = statements.join('\n');
  assert.ok(!v2only.includes('SET version = 2'));
  assert.ok(v2only.includes('ADD COLUMN collector_id'));
  assert.ok(v2only.includes('ADD COLUMN cancelled_at'));

  // A v3 database — the owner's current state — takes only the cancellation step.
  statements.length = 0;
  assert.deepEqual(await migratePickups(fakePool(3)), { action: 'upgraded', schemaVersion: 6, fromVersion: 3, legacyRequests: 1 });
  const v3only = statements.join('\n');
  assert.ok(!v3only.includes('ADD COLUMN collector_id'), 'v3 columns are not re-added');
  assert.ok(v3only.includes('ADD COLUMN cancelled_at'));
  assert.ok(v3only.includes('SET version = 4'));

  // A recorded version that the table does not honour is refused, not reported
  // as a successful no-op. This is the "already version 3" lie.
  statements.length = 0;
  await assert.rejects(() => migratePickups(fakePool(6, ['collector_id', 'actual_grams'])),
    /claims version 6 but is missing: accepted_at/);
  const refused = statements.join('\n');
  assert.ok(!refused.includes('SET version = 3'), 'nothing may be written when verification fails');

  // A current database is reported as unchanged, and an unknown version fails.
  assert.equal((await migratePickups(fakePool(6))).action, 'unchanged');
  await assert.rejects(() => migratePickups(fakePool(7)), /Unsupported schema/);

  // A fresh schema is 'created' from version 0 and lands directly at 3.
  statements.length = 0;
  const fresh = await migratePickups({ connect: async () => ({
    query: async (sql, params) => {
      statements.push(typeof sql === 'string' ? sql.replace(/\s+/g, ' ').trim() : sql);
      if (sql.includes('pg_namespace')) return { rows: [{ exists: false }] };
      if (sql.includes('to_regclass')) return { rows: [{ marker: 'schema' }] };
      if (sql.includes('information_schema.columns')) {
        const wanted = new Set(params?.[0] ?? []);
        const pool = wanted.has('request_id') ? PAYOUT : V3;
        return { rows: pool.filter(name => wanted.has(name)).map(name => ({ column_name: name })) };
      }
      if (/^SELECT version FROM kabadi_(authz|customer|catalog)\.schema_version$/.test(sql)) return { rows: [{ version: 1 }] };
      if (sql.includes('SELECT count(*)')) return { rows: [{ legacy: '0', total: '0' }] };
      return { rows: [] };
    }, release: () => {},
  }) });
  assert.deepEqual(fresh, { action: 'created', schemaVersion: 6, fromVersion: 0, legacyRequests: 0 });
  const created = statements.join('\n');
  assert.ok(created.includes('CHECK (version = 6)'));
  assert.ok(created.includes('INSERT INTO kabadi_pickup.schema_version VALUES (6)'));
  // A fresh table defines the cancellation columns directly, not via ALTER.
  assert.ok(created.includes('cancelled_at timestamptz'));
  assert.ok(created.includes('released_at timestamptz'));
});

// A database still at schema v2 breaks the v3 column list. That must read as
// "migrate me", not as a generic outage, and must not leak SQL.
test('an unmigrated database reports PICKUP_SCHEMA_OUTDATED instead of a vague outage', async () => {
  const { isMissingCollectorColumns } = await import('../../apps/api/dist/pickups.js');
  const undefinedColumn = Object.assign(new Error('column "actual_grams" does not exist'), { code: '42703' });
  assert.equal(isMissingCollectorColumns(undefinedColumn), true);
  // Unrelated database faults stay generic, so a real outage is not mislabelled.
  for (const other of [null, undefined, new Error('boom'), { code: '08006' }, { code: '42P01' }, { code: 42703 }]) {
    assert.equal(isMissingCollectorColumns(other), false, `expected generic: ${JSON.stringify(other)}`);
  }

  const missing = async () => { throw undefinedColumn; };
  const auth = { origin:'http://localhost:3000', handler:async()=>{}, resolveIdentity:async()=>({userId:'someone',cookies:[]}),
    pickups:{create:async()=>({outcome:'conflict'}), list:missing},
    collector:{open:missing, mine:missing, accept:missing, collect:missing} };
  const server = createApp(auth).listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const url of [`${base}/api/v1/customer/pickups`, `${base}/api/v1/collector/pickups?view=open`]) {
      const response = await fetch(url);
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.error.code, 'PICKUP_SCHEMA_OUTDATED', url);
      assert.match(body.error.message, /migration/i);
      assert.ok(!JSON.stringify(body).includes('actual_grams'), 'no SQL detail may leak');
    }
    const mutations = await fetch(`${base}/api/v1/collector/pickups/${randomUUID()}/accept`,
      {method:'POST', headers:{origin:'http://localhost:3000','content-type':'application/json'}, body:'{}'});
    assert.equal(mutations.status, 503);
    assert.equal((await mutations.json()).error.code, 'PICKUP_SCHEMA_OUTDATED');
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

// ---- Cancellation and release --------------------------------------------
test('customer cancel is own-row only, optional reason, and terminal', async () => {
  const requestId = randomUUID();
  const called = [];
  let outcome = { outcome: 'cancelled' };
  const auth = { origin:'http://localhost:3000', handler:async()=>{}, resolveIdentity:async()=>({userId:'owner',cookies:[]}),
    pickups:{ create:async()=>({outcome:'conflict'}), list:async()=>[],
      cancel:async (id, rid, reason)=>{ called.push([id, rid, reason]); return outcome; } },
    collector:{ open:async()=>[], mine:async()=>[], accept:async()=>({outcome:'accepted'}),
      collect:async()=>({outcome:'accepted'}), release:async()=>({outcome:'released'}) } };
  const server = createApp(auth).listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/v1/customer/pickups/${requestId}/cancel`;
    const post = (body, headers={}) => fetch(url, { method:'POST',
      headers:{ origin:'http://localhost:3000', 'content-type':'application/json', ...headers }, body });
    // No reason at all is the normal case: cancelling needs no justification.
    let response = await post('{}');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { cancelled: true } });
    assert.deepEqual(called.pop(), ['owner', requestId, null]);
    // A reason is optional, bounded, and trimmed by the same text rule.
    response = await post(JSON.stringify({ reason: 'Found another collector' }));
    assert.equal(response.status, 200);
    assert.deepEqual(called.pop(), ['owner', requestId, 'Found another collector']);
    for (const body of ['{"reason":""}', '{"reason":"   "}', `{"reason":"${'x'.repeat(201)}"}`,
      '{"reason":"a","status":"collected"}', '{"collectorId":"x"}', '[]', 'null']) {
      assert.equal((await post(body)).status, 400, `expected rejection: ${body.slice(0,60)}`);
    }
    assert.equal(called.length, 0, 'a rejected body never reaches the store');
    // Guards match every other write.
    assert.equal((await post('{}', { origin:'https://evil.example' })).status, 403);
    assert.equal((await post('{}', { 'content-type':'text/plain' })).status, 415);
    assert.equal((await fetch(url.replace(requestId, 'not-a-uuid'), { method:'POST',
      headers:{ origin:'http://localhost:3000', 'content-type':'application/json' }, body:'{}' })).status, 400);

    for (const [v, status, code] of [
      [{outcome:'not-found'}, 404, 'REQUEST_NOT_FOUND'],
      [{outcome:'already-cancelled'}, 409, 'ALREADY_CANCELLED'],
      [{outcome:'already-collected'}, 409, 'ALREADY_COLLECTED'],
    ]) {
      outcome = v;
      response = await post('{}');
      assert.equal(response.status, status); assert.equal((await response.json()).error.code, code);
    }
    outcome = 'forbidden'; assert.equal((await post('{}')).status, 403);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('collector release returns the claim to the open queue and is distinct from cancel', async () => {
  const requestId = randomUUID();
  const called = [];
  let outcome = { outcome: 'released' };
  const auth = { origin:'http://localhost:3000', handler:async()=>{}, resolveIdentity:async()=>({userId:'col-1',cookies:[]}),
    pickups:{ create:async()=>({outcome:'conflict'}), list:async()=>[], cancel:async()=>({outcome:'cancelled'}) },
    collector:{ open:async()=>[], mine:async()=>[], accept:async()=>({outcome:'accepted'}),
      collect:async()=>({outcome:'accepted'}),
      release:async (id, rid)=>{ called.push([id, rid]); return outcome; } } };
  const server = createApp(auth).listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/v1/collector/pickups/${requestId}/release`;
    const post = (body='{}') => fetch(url, { method:'POST',
      headers:{ origin:'http://localhost:3000', 'content-type':'application/json' }, body });
    let response = await post();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { released: true } });
    assert.deepEqual(called.pop(), ['col-1', requestId]);
    // Release takes no body at all, so a weight cannot be smuggled in.
    assert.equal((await post('{"actualGrams":2300}')).status, 400);
    assert.equal(called.length, 0);
    for (const [v, status, code] of [
      [{outcome:'not-found'}, 404, 'REQUEST_NOT_FOUND'],
      [{outcome:'not-accepted'}, 409, 'NOT_ACCEPTED'],
      [{outcome:'already-collected'}, 409, 'ALREADY_COLLECTED'],
      [{outcome:'cancelled'}, 409, 'REQUEST_CANCELLED'],
    ]) {
      outcome = v;
      response = await post();
      assert.equal(response.status, status); assert.equal((await response.json()).error.code, code);
    }
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('a collector cannot accept their own request and the UI is told why', async () => {
  const requestId = randomUUID();
  let outcome = { outcome: 'own-request' };
  const auth = { origin:'http://localhost:3000', handler:async()=>{}, resolveIdentity:async()=>({userId:'both',cookies:[]}),
    pickups:{ create:async()=>({outcome:'conflict'}), list:async()=>[], cancel:async()=>({outcome:'cancelled'}) },
    collector:{ open:async()=>[], mine:async()=>[], accept:async()=>outcome, collect:async()=>outcome,
      release:async()=>({outcome:'released'}) } };
  const server = createApp(auth).listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/v1/collector/pickups/${requestId}`;
    const post = (path, body) => fetch(`${base}/${path}`, { method:'POST',
      headers:{ origin:'http://localhost:3000', 'content-type':'application/json' }, body:JSON.stringify(body) });
    let response = await post('accept', {});
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'OWN_REQUEST');
    // The same rule blocks a self-collection attempt.
    outcome = { outcome: 'cancelled' };
    response = await post('collect', { actualGrams: 2300 });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'REQUEST_CANCELLED');
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

// The store's guarantees are in its SQL, so assert on the statements a fake
// client actually receives: a status the WHERE clause does not allow cannot be
// updated, which is what makes "cancel loses to a collection" true.
test('store SQL encodes ownership, terminal states and the self-accept guard', async () => {
  const { createPickupStore, createCollectorStore } = await import('../../apps/api/dist/pickups.js');
  function recordingPool(responder) {
    const seen = [];
    return { seen, pool: { connect: async () => ({
      query: async (sql, params) => {
        const text = typeof sql === 'string' ? sql.replace(/\s+/g,' ').trim() : '';
        seen.push({ text, params });
        return responder(text, params);
      },
      release: () => {},
    }) } };
  }
  // A generic healthy responder: account active, collector grant present, and
  // every UPDATE reports one affected row unless a scenario overrides it.
  const healthy = text => {
    if (text.startsWith('SELECT status FROM kabadi_authz.accounts')) return { rows: [{ status: 'active' }] };
    if (text.includes('FROM kabadi_authz.role_grants')) return { rows: [{}], rowCount: 1 };
    if (text.includes('FOR UPDATE')) return { rows: [{ status: 'accepted', collector_id: 'col-1', category_id: randomUUID() }] };
    if (text.includes('FROM kabadi_catalog.rates')) return { rows: [{ id: randomUUID(), paise_per_kg: 3245 }] };
    return { rows: [], rowCount: 1 };
  };

  const requestId = randomUUID();
  const cancels = recordingPool(healthy);
  await createPickupStore(cancels.pool).cancel('owner', requestId, 'no longer needed');
  const cancelSql = cancels.seen.find(q => q.text.startsWith('UPDATE kabadi_pickup.requests'));
  assert.ok(cancelSql, 'cancel issues an UPDATE');
  // Ownership, a terminal-state whitelist, and the reason are all in the SQL.
  assert.match(cancelSql.text, /WHERE id=\$1 AND user_id=\$2 AND status IN \('requested','accepted'\)/);
  assert.match(cancelSql.text, /status='cancelled'/);
  assert.match(cancelSql.text, /cancelled_at=now\(\)/);
  assert.deepEqual(cancelSql.params, [requestId, 'owner', 'no longer needed']);
  // A cancelled row drops its claim so the queue cannot show a phantom owner.
  assert.match(cancelSql.text, /collector_id=NULL/);

  const releases = recordingPool(healthy);
  await createCollectorStore(releases.pool).release('col-1', requestId);
  const releaseSql = releases.seen.find(q => q.text.startsWith('UPDATE kabadi_pickup.requests'));
  assert.match(releaseSql.text, /SET status='requested', collector_id=NULL, accepted_at=NULL, released_at=now\(\)/);
  assert.match(releaseSql.text, /WHERE id=\$1 AND status='accepted' AND collector_id=\$2/);

  const accepts = recordingPool(healthy);
  await createCollectorStore(accepts.pool).accept('col-1', requestId);
  const acceptSql = accepts.seen.find(q => q.text.startsWith('UPDATE kabadi_pickup.requests'));
  assert.match(acceptSql.text, /AND user_id <> \$2/, 'a collector may never claim their own request');
  assert.match(acceptSql.text, /AND status='requested'/);

  // A collector without the grant is refused before any row is touched.
  const ungranted = recordingPool(text => {
    if (text.startsWith('SELECT status FROM kabadi_authz.accounts')) return { rows: [{ status: 'active' }] };
    if (text.includes('FROM kabadi_authz.role_grants')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });
  assert.equal(await createCollectorStore(ungranted.pool).accept('col-2', requestId), 'forbidden');
  assert.ok(!ungranted.seen.some(q => q.text.startsWith('UPDATE')), 'no write without a grant');

  // A suspended account is refused even with the grant row present.
  const suspended = recordingPool(text => {
    if (text.startsWith('SELECT status FROM kabadi_authz.accounts')) return { rows: [{ status: 'suspended' }] };
    if (text.includes('FROM kabadi_authz.role_grants')) return { rows: [{}], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  assert.equal(await createCollectorStore(suspended.pool).release('col-3', requestId), 'forbidden');
});

// ---- Disputes ------------------------------------------------------------
test('customer raises a dispute only on their own collected request', async () => {
  const requestId = randomUUID();
  const called = [];
  let outcome = { outcome: 'raised' };
  const auth = { origin:'http://localhost:3000', handler:async()=>{}, resolveIdentity:async()=>({userId:'owner',cookies:[]}),
    pickups:{ create:async()=>({outcome:'conflict'}), list:async()=>[],
      cancel:async()=>({outcome:'cancelled'}),
      raiseDispute:async (id, rid, reason)=>{ called.push([id, rid, reason]); return outcome; } },
    collector:{ open:async()=>[], mine:async()=>[], accept:async()=>({outcome:'accepted'}),
      collect:async()=>({outcome:'accepted'}), release:async()=>({outcome:'released'}) } };
  const server = createApp(auth).listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/v1/customer/pickups/${requestId}/dispute`;
    const post = (body, headers={}) => fetch(url, { method:'POST',
      headers:{ origin:'http://localhost:3000', 'content-type':'application/json', ...headers }, body });
    let response = await post(JSON.stringify({ reason: 'The weight was about 2 kg, not 2.3' }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { raised: true } });
    assert.deepEqual(called.pop(), ['owner', requestId, 'The weight was about 2 kg, not 2.3']);
    // Unlike cancellation, a dispute must say why: an admin has to know what to check.
    for (const body of ['{}', '{"reason":""}', '{"reason":"  "}', `{"reason":"${'x'.repeat(201)}"}`,
      '{"reason":"a","actualGrams":1}', '{"correctedGrams":2000}']) {
      assert.equal((await post(body)).status, 400, `expected rejection: ${body.slice(0,50)}`);
    }
    assert.equal(called.length, 0, 'a rejected body never reaches the store');
    assert.equal((await post('{"reason":"valid reason here"}', { origin:'https://evil.example' })).status, 403);
    for (const [v, status, code] of [
      [{outcome:'not-found'}, 404, 'REQUEST_NOT_FOUND'],
      [{outcome:'not-collected'}, 409, 'NOT_COLLECTED'],
      [{outcome:'already-open'}, 409, 'DISPUTE_OPEN'],
    ]) {
      outcome = v; response = await post(JSON.stringify({ reason:'valid reason here' }));
      assert.equal(response.status, status); assert.equal((await response.json()).error.code, code);
    }
    outcome = 'forbidden'; assert.equal((await post('{"reason":"valid reason here"}')).status, 403);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('admin resolves a dispute by re-pricing at the frozen rate, never a fresh lookup', async () => {
  const { createDisputeStore } = await import('../../apps/api/dist/pickups.js');
  const requestId = randomUUID();
  const seen = [];
  // The row was collected at 3245 paise/kg. The catalog's current rate is
  // deliberately different; a resolution must ignore it entirely.
  const pool = { connect: async () => ({
    query: async (sql, params) => {
      const text = typeof sql === 'string' ? sql.replace(/\s+/g,' ').trim() : '';
      seen.push({ text, params });
      if (text.startsWith('SELECT status FROM kabadi_authz.accounts')) return { rows: [{ status: 'active' }] };
      if (text.includes("role='admin'")) return { rows: [{}], rowCount: 1 };
      if (text.includes('FOR UPDATE')) return { rows: [{ status: 'collected', dispute_status: 'open',
        actual_grams: 2300, final_paise_per_kg: 3245, final_rate_id: randomUUID() }] };
      return { rows: [], rowCount: 1 };
    }, release: () => {},
  }) };
  const store = createDisputeStore(pool);
  const result = await store.resolveDispute('admin-1', requestId, 2000);
  assert.deepEqual(result, { outcome: 'resolved', actualGrams: 2000, finalPaisePerKg: 3245, finalAmountPaise: '6490' });
  // No catalog read at all: the frozen rate is the only price input.
  assert.ok(!seen.some(q => q.text.includes('kabadi_catalog.rates')), 'resolution must not query the catalog');
  const update = seen.find(q => q.text.startsWith('UPDATE kabadi_pickup.requests'));
  assert.match(update.text, /final_amount_paise=\$3::bigint/);
  // The per-kg rate is not in the SET list at all: it cannot drift because it is
  // never written again. Only the weight and the derived amount change.
  assert.doesNotMatch(update.text, /SET[^]*final_paise_per_kg\s*=/, 'the frozen per-kg rate is never rewritten');
  assert.doesNotMatch(update.text, /final_rate_id\s*=/, 'the frozen rate id is never rewritten');
  assert.match(update.text, /dispute_status='resolved'/);
  assert.deepEqual(update.params, [requestId, 2000, '6490']);
  // 2000 g at 3245 = 6490 paise exactly, no rounding surprise.
  assert.equal(6490, Math.round(2000 * 3245 / 1000));
});

// ---- Payout ledger -------------------------------------------------------
test('admin records a payout once, at the settled amount, never on a disputed request', async () => {
  const { createPayoutStore } = await import('../../apps/api/dist/pickups.js');
  const requestId = randomUUID();
  const seen = [];
  // The settlement says 6490 paise; the browser will try to claim 10 paise.
  function pool(row, insertOk = true) {
    return { connect: async () => ({
      query: async (sql, params) => {
        const text = typeof sql === 'string' ? sql.replace(/\s+/g,' ').trim() : '';
        seen.push({ text, params });
        if (text.startsWith('SELECT status FROM kabadi_authz.accounts')) return { rows: [{ status: 'active' }] };
        if (text.includes("role='admin'")) return { rows: [{}], rowCount: 1 };
        if (text.includes('FOR UPDATE OF r')) return { rows: [row] };
        if (text.startsWith('INSERT INTO kabadi_pickup.payouts')) return { rows: insertOk ? [{ request_id: requestId }] : [], rowCount: insertOk ? 1 : 0 };
        return { rows: [], rowCount: 0 };
      }, release: () => {},
    }) };
  }

  const due = { status:'collected', collector_id:'col-1', final_amount_paise:'6490', dispute_status:null, paid:false };
  const ok = pool(due);
  const result = await createPayoutStore(ok).recordPayout('admin-1', requestId, 'cash', null, 'handed over at the shop');
  assert.deepEqual(result, { outcome: 'paid', amountPaise: '6490', method: 'cash' });
  const insert = seen.find(q => q.text.startsWith('INSERT INTO kabadi_pickup.payouts'));
  // The amount comes from the row, never from the request body.
  assert.equal(insert.params[2], '6490');
  assert.equal(insert.params[1], 'col-1', 'the payee is the collector on the row');
  assert.equal(insert.params[5], 'admin-1', 'the recorder is the acting admin');
  assert.match(insert.text, /ON CONFLICT \(request_id\) DO NOTHING/, 'the primary key is the double-payment guard');

  // Already paid: refused, and no insert is attempted at all.
  seen.length = 0;
  assert.deepEqual(await createPayoutStore(pool({ ...due, paid: true }))
    .recordPayout('admin-1', requestId, 'cash', null, null), { outcome: 'already-paid' });
  assert.ok(!seen.some(q => q.text.startsWith('INSERT INTO kabadi_pickup.payouts')));

  // An open dispute blocks payment: the amount is not final yet.
  seen.length = 0;
  assert.deepEqual(await createPayoutStore(pool({ ...due, dispute_status: 'open' }))
    .recordPayout('admin-1', requestId, 'cash', null, null), { outcome: 'disputed' });
  assert.ok(!seen.some(q => q.text.startsWith('INSERT INTO kabadi_pickup.payouts')));

  // A rejected dispute does not block payment: it was reviewed and stood.
  assert.equal((await createPayoutStore(pool({ ...due, dispute_status: 'rejected' }))
    .recordPayout('admin-1', requestId, 'transfer', 'UTR-123', null)).outcome, 'paid');

  // Uncollected rows cannot be paid.
  assert.deepEqual(await createPayoutStore(pool({ ...due, status: 'accepted' }))
    .recordPayout('admin-1', requestId, 'cash', null, null), { outcome: 'not-collected' });

  // A concurrent insert loses cleanly instead of crashing.
  assert.deepEqual(await createPayoutStore(pool(due, false))
    .recordPayout('admin-1', requestId, 'cash', null, null), { outcome: 'already-paid' });

  // A collector without the admin grant cannot record a payment.
  const ungranted = { connect: async () => ({
    query: async (sql) => {
      const text = typeof sql === 'string' ? sql.replace(/\s+/g,' ').trim() : '';
      if (text.startsWith('SELECT status FROM kabadi_authz.accounts')) return { rows: [{ status: 'active' }] };
      if (text.includes("role='admin'")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    }, release: () => {},
  }) };
  assert.equal(await createPayoutStore(ungranted).recordPayout('col-1', requestId, 'cash', null, null), 'forbidden');
});

test('payout routes reject a client-supplied amount and enforce method and origin', async () => {
  const requestId = randomUUID();
  const called = [];
  let outcome = { outcome: 'paid', amountPaise: '6490', method: 'cash' };
  const auth = { origin:'http://localhost:3000', handler:async()=>{}, resolveIdentity:async()=>({userId:'admin-1',cookies:[]}),
    pickups:{ create:async()=>({outcome:'conflict'}), list:async()=>[], cancel:async()=>({outcome:'cancelled'}),
      raiseDispute:async()=>({outcome:'raised'}) },
    collector:{ open:async()=>[], mine:async()=>[], accept:async()=>({outcome:'accepted'}),
      collect:async()=>({outcome:'accepted'}), release:async()=>({outcome:'released'}) },
    disputes:{ openDisputes:async()=>[], resolveDispute:async()=>({outcome:'resolved'}), rejectDispute:async()=>({outcome:'rejected'}) },
    payouts:{ unpaidCollectorDues:async()=>[],
      recordPayout:async (actor, rid, method, reference, note)=>{ called.push([actor, rid, method, reference, note]); return outcome; } } };
  const server = createApp(auth).listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/v1/admin/payouts/${requestId}/pay`;
    const post = (body, headers={}) => fetch(url, { method:'POST',
      headers:{ origin:'http://localhost:3000', 'content-type':'application/json', ...headers }, body });
    let response = await post(JSON.stringify({ method:'cash' }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { paid:true, amountPaise:'6490', method:'cash' } });
    assert.deepEqual(called.pop(), ['admin-1', requestId, 'cash', null, null]);

    // An amount in the body is refused outright, not ignored: the server decides.
    for (const body of [
      JSON.stringify({ method:'cash', amountPaise:'10' }),
      JSON.stringify({ method:'cash', amountPaise:6490 }),
      JSON.stringify({ amountPaise:'10' }),
      JSON.stringify({ method:'cheque' }),
      JSON.stringify({}),
      JSON.stringify({ method:'cash', reference:'x'.repeat(101) }),
      JSON.stringify({ method:'cash', note:'y'.repeat(201) }),
    ]) {
      assert.equal((await post(body)).status, 400, `expected rejection: ${body.slice(0,60)}`);
    }
    assert.equal(called.length, 0, 'a rejected body never reaches the store');
    assert.equal((await post('{"method":"cash"}', { origin:'https://evil.example' })).status, 403);
    assert.equal((await post('{"method":"cash"}', { 'content-type':'text/plain' })).status, 415);

    for (const [v, status, code] of [
      [{outcome:'not-found'}, 404, 'REQUEST_NOT_FOUND'],
      [{outcome:'not-collected'}, 409, 'NOT_COLLECTED'],
      [{outcome:'already-paid'}, 409, 'ALREADY_PAID'],
      [{outcome:'disputed'}, 409, 'DISPUTE_OPEN'],
    ]) {
      outcome = v; response = await post('{"method":"cash"}');
      assert.equal(response.status, status); assert.equal((await response.json()).error.code, code);
    }
    outcome = 'forbidden'; assert.equal((await post('{"method":"cash"}')).status, 403);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('the payout method list cannot drift from the schema CHECK constraint', async () => {
  const { PAYOUT_METHODS, isPayoutMethod, PAYMENT_PROVIDER } = await import('../../apps/api/dist/pickups.js');
  // The CHECK constraint is SQL text and cannot read a TypeScript constant, so
  // the two lists are kept in step by this assertion instead. Adding a method
  // in one place only is a schema drift waiting to happen.
  const source = await readFile(new URL('../../apps/api/src/pickups.ts', import.meta.url), 'utf8');
  const checks = [...source.matchAll(/method text NOT NULL CHECK \(method IN \(([^)]*)\)\)/g)];
  assert.equal(checks.length, 2, 'the fresh CREATE and the v5->v6 step must both declare it');
  for (const [, list] of checks) {
    const inSql = list.split(',').map(v => v.trim().replace(/^'|'$/g, ''));
    assert.deepEqual(inSql, [...PAYOUT_METHODS], 'SQL CHECK and PAYOUT_METHODS must match exactly');
  }
  for (const method of PAYOUT_METHODS) assert.equal(isPayoutMethod(method), true);
  for (const bad of ['upi', 'cheque', 'CASH', '', null, undefined, 1, {}, []]) {
    assert.equal(isPayoutMethod(bad), false, `must reject ${JSON.stringify(bad)}`);
  }
  // Nothing in the codebase may claim a provider is connected while none is.
  assert.deepEqual(PAYMENT_PROVIDER, { configured: false, name: null });
});

test('the payout queue tells the browser that no provider can move money', async () => {
  const requestId = randomUUID();
  const row = { id: requestId, status: 'collected', createdAt: '2026-11-20T10:00:00.000Z',
    address: { name: 'Sample', addressLine: '12 Example', city: 'Ludhiana', state: 'Punjab', postalCode: '141001' },
    categoryId: '123e4567-e89b-42d3-a456-426614174181', categoryName: 'Synthetic paper',
    estimatedGrams: 2500, actualGrams: 2000, actualGrams2: 2000,
    rateId: '123e4567-e89b-42d3-a456-426614174182', paisePerKg: 3245, amountPaise: '8113',
    finalRateId: '123e4567-e89b-42d3-a456-426614174183', finalPaisePerKg: 3245,
    finalAmountPaise: '6490', collectedAt: '2026-11-20T10:00:00.000Z',
    cancelledAt: null, cancellationReason: null, releasedAt: null, dispute: null, payout: null, material: null };
  const auth = { origin:'http://localhost:3000', handler:async()=>{}, resolveIdentity:async()=>({userId:'admin-1',cookies:[]}),
    pickups:{ create:async()=>({outcome:'conflict'}), list:async()=>[], cancel:async()=>({outcome:'cancelled'}),
      raiseDispute:async()=>({outcome:'raised'}) },
    collector:{ open:async()=>[], mine:async()=>[], accept:async()=>({outcome:'accepted'}),
      collect:async()=>({outcome:'accepted'}), release:async()=>({outcome:'released'}) },
    disputes:{ openDisputes:async()=>[], resolveDispute:async()=>({outcome:'resolved'}), rejectDispute:async()=>({outcome:'rejected'}) },
    payouts:{ unpaidCollectorDues:async()=>[row], recordPayout:async()=>({outcome:'paid'}) } };
  const server = createApp(auth).listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin/payouts`,
      { headers: { origin:'http://localhost:3000' } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.dues.length, 1);
    // The absence of a provider is stated by the server, not inferred by the UI.
    assert.deepEqual(body.data.payment, { configured: false, name: null, methods: ['cash','transfer','adjustment'] });
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('the notification placeholder promises nothing and covers every real state change', async () => {
  const { NOTIFICATION_EVENTS, NOTIFICATION_CHANNELS, NOTIFICATION_PROVIDER, isNotificationEvent } =
    await import('../../apps/api/dist/notifications.js');

  // Every event listed must correspond to a transition that actually exists in
  // the store. If a feature is added without updating this list, or removed
  // while the list keeps advertising it, that is a lie in the UI.
  const source = await readFile(new URL('../../apps/api/src/pickups.ts', import.meta.url), 'utf8');
  for (const [event, marker] of [
    ['pickup-requested', 'INSERT INTO kabadi_pickup.requests'],
    ['pickup-accepted', "SET status='accepted'"],
    ['pickup-collected', "SET status='collected'"],
    ['pickup-cancelled', "status='cancelled'"],
    ['dispute-raised', 'SET dispute_status='],
    ['payout-recorded', 'INSERT INTO kabadi_pickup.payouts'],
  ]) {
    assert.ok(NOTIFICATION_EVENTS.includes(event), `${event} must be listed`);
    assert.ok(source.includes(marker), `${event} has no matching transition in the store`);
  }
  // Claiming delivery requires a transport; there is none, so this must be false
  // and a test fails the moment someone flips it without building one.
  assert.equal(NOTIFICATION_PROVIDER.configured, false);
  assert.equal(NOTIFICATION_PROVIDER.delivery, 'none');
  assert.deepEqual([...NOTIFICATION_PROVIDER.channels], []);
  // Channels were considered, not silently defaulted to.
  assert.deepEqual([...NOTIFICATION_CHANNELS], ['in-app', 'email', 'sms', 'whatsapp']);
  assert.equal(isNotificationEvent('pickup-collected'), true);
  for (const bad of ['pickup-paid', 'PICKUP-COLLECTED', '', null, 1]) {
    assert.equal(isNotificationEvent(bad), false, `must reject ${JSON.stringify(bad)}`);
  }
});

test('both pickup lists tell the browser that no notification will be sent', async () => {
  const address = { name: 'Sample', addressLine: '12 Example', city: 'Ludhiana', state: 'Punjab', postalCode: '141001' };
  const requested = { id: randomUUID(), status: 'requested', createdAt: '2026-11-20T10:00:00.000Z',
    address, estimatedGrams: 2500, material: null,
    categoryId: '123e4567-e89b-42d3-a456-426614174191', categoryName: 'Synthetic paper',
    rateId: '123e4567-e89b-42d3-a456-426614174192', paisePerKg: 3245, amountPaise: '8113',
    actualGrams: null, finalRateId: null, finalPaisePerKg: null, finalAmountPaise: null, collectedAt: null,
    cancelledAt: null, cancellationReason: null, releasedAt: null, dispute: null, payout: null };
  const auth = { origin:'http://localhost:3000', handler:async()=>{}, resolveIdentity:async()=>({userId:'customer-1',cookies:[]}),
    onboardCustomer:async()=>({outcome:'ready'}),
    customerDetails:{ get:async()=>({outcome:'ready', details:address}), save:async()=>({outcome:'saved'}) },
    pickups:{ create:async()=>({outcome:'conflict'}), list:async()=>[requested], cancel:async()=>({outcome:'cancelled'}),
      raiseDispute:async()=>({outcome:'raised'}) },
    collector:{ open:async()=>[], mine:async()=>[], accept:async()=>({outcome:'accepted'}),
      collect:async()=>({outcome:'accepted'}), release:async()=>({outcome:'released'}) },
    disputes:{ openDisputes:async()=>[], resolveDispute:async()=>({outcome:'resolved'}), rejectDispute:async()=>({outcome:'rejected'}) },
    payouts:{ unpaidCollectorDues:async()=>[], recordPayout:async()=>({outcome:'paid'}) } };
  const server = createApp(auth).listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/customer/pickups`,
      { headers: { origin:'http://localhost:3000' } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.pickups.length, 1);
    // Same descriptor the admin queue returns, so the two screens cannot
    // disagree about whether anything is sent.
    assert.equal(body.data.notifications.configured, false);
    assert.equal(body.data.notifications.delivery, 'none');
    assert.deepEqual(body.data.notifications.channels, []);
    assert.ok(body.data.notifications.events.includes('payout-recorded'));
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
