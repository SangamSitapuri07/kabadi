import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
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
  const empty = { actualGrams:null, finalRateId:null, finalPaisePerKg:null, finalAmountPaise:null, collectedAt:null };
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
    assert.deepEqual(await response.json(), {data:{pickups:[priced, legacy]}});
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
    actualGrams:null, finalRateId:null, finalPaisePerKg:null, finalAmountPaise:null, collectedAt:null };
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
    actualGrams:null, finalRateId:null, finalPaisePerKg:null, finalAmountPaise:null, collectedAt:null };
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
test('pickup migration walks v1 to v3 in one run and reports the real starting version', async () => {
  const { migratePickups } = await import('../../apps/api/dist/pickups.js');
  const statements = [];
  const V3 = ['collector_id', 'accepted_at', 'collected_at', 'actual_grams',
    'final_rate_id', 'final_paise_per_kg', 'final_amount_paise'];
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
          return { rows: columns.filter(name => wanted.has(name)).map(name => ({ column_name: name })) };
        }
        if (sql.includes('SELECT count(*)')) return { rows: [{ legacy: '1', total: '2' }] };
        return { rows: [] };
      },
      release: () => {},
    }) };
  }

  const report = await migratePickups(fakePool(1));
  assert.deepEqual(report, { action: 'upgraded', schemaVersion: 3, fromVersion: 1, legacyRequests: 1 });
  const all = statements.join('\n');
  // Both upgrade steps ran, in order, and each pinned its own version.
  assert.ok(all.indexOf('SET version = 2') < all.indexOf('ADD COLUMN collector_id'), 'v2 upgrade precedes v3');
  assert.ok(all.includes("ADD CONSTRAINT requests_status_check CHECK (status IN ('requested','accepted','collected'))"));
  assert.ok(all.includes('ADD COLUMN actual_grams integer CHECK (actual_grams BETWEEN 1 AND 10000000)'));
  assert.ok(all.includes('ADD CONSTRAINT pickup_lifecycle CHECK'));
  assert.ok(all.includes('CREATE INDEX pickup_open'));
  assert.ok(all.includes('CREATE INDEX pickup_collector'));
  assert.ok(all.includes('SET version = 3'));
  // Existing rows are never rewritten or deleted by the upgrade.
  assert.ok(!/DELETE FROM kabadi_pickup\.requests/i.test(all));
  assert.ok(!/UPDATE kabadi_pickup\.requests SET (material|status)/i.test(all));

  // A v2 database takes only the second step and stays 'upgraded'.
  statements.length = 0;
  assert.deepEqual(await migratePickups(fakePool(2)), { action: 'upgraded', schemaVersion: 3, fromVersion: 2, legacyRequests: 1 });
  const v2only = statements.join('\n');
  assert.ok(!v2only.includes('SET version = 2'));
  assert.ok(v2only.includes('ADD COLUMN collector_id'));

  // A recorded version that the table does not honour is refused, not reported
  // as a successful no-op. This is the "already version 3" lie.
  statements.length = 0;
  await assert.rejects(() => migratePickups(fakePool(3, ['collector_id', 'actual_grams'])),
    /claims version 3 but is missing: accepted_at/);
  const refused = statements.join('\n');
  assert.ok(!refused.includes('SET version = 3'), 'nothing may be written when verification fails');

  // A current database is reported as unchanged, and an unknown version fails.
  assert.equal((await migratePickups(fakePool(3))).action, 'unchanged');
  await assert.rejects(() => migratePickups(fakePool(4)), /Unsupported schema/);

  // A fresh schema is 'created' from version 0 and lands directly at 3.
  statements.length = 0;
  const fresh = await migratePickups({ connect: async () => ({
    query: async (sql, params) => {
      statements.push(typeof sql === 'string' ? sql.replace(/\s+/g, ' ').trim() : sql);
      if (sql.includes('pg_namespace')) return { rows: [{ exists: false }] };
      if (sql.includes('to_regclass')) return { rows: [{ marker: 'schema' }] };
      if (sql.includes('information_schema.columns')) {
        const wanted = new Set(params?.[0] ?? []);
        return { rows: V3.filter(name => wanted.has(name)).map(name => ({ column_name: name })) };
      }
      if (/^SELECT version FROM kabadi_(authz|customer|catalog)\.schema_version$/.test(sql)) return { rows: [{ version: 1 }] };
      if (sql.includes('SELECT count(*)')) return { rows: [{ legacy: '0', total: '0' }] };
      return { rows: [] };
    }, release: () => {},
  }) });
  assert.deepEqual(fresh, { action: 'created', schemaVersion: 3, fromVersion: 0, legacyRequests: 0 });
  const created = statements.join('\n');
  assert.ok(created.includes('CHECK (version = 3)'));
  assert.ok(created.includes('INSERT INTO kabadi_pickup.schema_version VALUES (3)'));
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
