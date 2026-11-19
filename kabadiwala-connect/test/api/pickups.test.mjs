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
  const priced = { id, status:'requested', createdAt:'2026-11-18T17:00:00.000Z', address, estimatedGrams:500,
    material:null, categoryId, categoryName:'Paper', rateId:randomUUID(), paisePerKg:3245, amountPaise:'1623' };
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
