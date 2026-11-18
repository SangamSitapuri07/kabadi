import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { parsePickup } from '../../apps/api/dist/pickups.js';
import { createApp } from '../../apps/api/dist/app.js';

const valid = {requestKey:randomUUID(), material:'  Paper  ', estimatedGrams:2500};
test('pickup input rejects identity, invalid weights and malformed materials', () => {
  assert.deepEqual(parsePickup(valid), {...valid,material:'Paper'});
  for (const input of [null, [], {}, {...valid, userId:'other'}, {...valid, estimatedGrams:0}, {...valid, estimatedGrams:1.5}, {...valid, estimatedGrams:10000001}, {...valid, material:'\u0000'}, {...valid, material:'x'.repeat(101)}, {...valid, requestKey:'bad'}]) assert.equal(parsePickup(input), null);
});
test('pickup API uses session identity and sanitizes failures', async () => {
  let identity = {userId:'owner', cookies:['refresh=value; HttpOnly']}, called = [], outcome = 'created';
  const auth = {origin:'http://localhost:3000', handler:async()=>{}, resolveIdentity:async()=>identity,
    pickups:{create:async (id, v)=>{called.push([id,v]); return outcome;}, list:async id=>{called.push(id); return [];}}};
  const server = createApp(auth).listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/v1/customer/pickups`;
    const post = (input, origin='http://localhost:3000') => fetch(url, {method:'POST',headers:{origin,'content-type':'application/json','x-user-id':'forged'},body:JSON.stringify(input)});
    assert.equal((await post(valid,'https://evil.example')).status,403);
    assert.equal((await post({...valid,userId:'other'})).status,400); assert.equal(called.length,0);
    let response = await post(valid); assert.equal(response.status,200); assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(response.headers.getSetCookie(), ['refresh=value; HttpOnly']);
    assert.deepEqual(called.pop(),['owner',{...valid,material:'Paper'}]);
    for (const [v,status,code] of [['missing-profile',409,'PROFILE_REQUIRED'],['conflict',409,'REQUEST_CONFLICT'],['forbidden',403,'FORBIDDEN']]) {
      outcome=v; response=await post(valid); assert.equal(response.status,status); assert.equal((await response.json()).error.code,code);
    }
    identity={userId:null,cookies:[]}; assert.equal((await fetch(url)).status,401); assert.equal((await post(valid)).status,401);
    identity={userId:'owner',cookies:[]}; auth.pickups.list=async()=>{throw Error('secret');};
    response=await fetch(url); assert.equal(response.status,503); assert.ok(!(await response.text()).includes('secret'));
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
