import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../../apps/api/dist/app.js';

test('development catalog routes validate writes, use session identity and fail closed', async () => {
  const categoryId = randomUUID(), rateId = randomUUID(), requestKey = randomUUID(), calls = [];
  let identity = {userId:'session-admin',cookies:['refresh=value; HttpOnly']}, result = {id:categoryId};
  const auth = {origin:'http://localhost:3000',handler:async()=>{},resolveIdentity:async()=>identity,
    catalog:{createCategory:async (...args)=>{calls.push(args); return result;},addRate:async (...args)=>{calls.push(args); return result;}}};
  const server = createApp(auth).listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/v1/admin/catalog/categories`;
    const post = (url, body, origin=auth.origin, headers={}) => fetch(url,{method:'POST',headers:{origin,'content-type':'application/json','x-user-id':'forged','x-role':'admin','idempotency-key':requestKey,...headers},body:JSON.stringify(body)});
    assert.equal((await post(base,{name:'Paper'},'https://evil.example')).status,403);
    for (const input of [{name:'Paper',userId:'forged'},{name:''}, {name:'Paper',role:'admin'},[]]) assert.equal((await post(base,input)).status,400);
    assert.equal((await post(base, {name:'a'.repeat(5000)})).status,413);
    assert.equal((await fetch(base,{method:'POST',headers:{origin:auth.origin,'content-type':'text/plain'},body:'{}'})).status,415);
    assert.equal(calls.length,0);
    let response = await post(base,{name:'Paper'});
    assert.equal(response.status,201); assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(response.headers.getSetCookie(), ['refresh=value; HttpOnly']);
    assert.deepEqual(await response.json(),{data:{id:categoryId}}); assert.deepEqual(calls.pop(),['session-admin','Paper',requestKey]);
    assert.equal((await post(base,{name:'Paper'},auth.origin,{'idempotency-key':'bad'})).status,400);
    assert.equal((await fetch(base,{method:'POST',headers:{origin:auth.origin,'content-type':'application/json'},body:JSON.stringify({name:'Paper'})})).status,400);
    result='conflict'; assert.equal((await post(base,{name:'Paper'})).status,409);
    result='duplicate'; assert.equal((await post(base,{name:'Paper'})).status,409);
    result='forbidden'; assert.equal((await post(base,{name:'Paper'})).status,403);
    identity={userId:null,cookies:[]}; assert.equal((await post(base,{name:'Paper'})).status,401);
    identity={userId:'session-admin',cookies:[]}; result={id:rateId};
    const ratePath = `${base}/${categoryId}/rates`, rate = {effectiveFrom:'2099-01-01T00:00:00.000Z',paisePerKg:123};
    for (const input of [{...rate,actorId:'forged'}, {...rate,paisePerKg:-1}, {...rate,effectiveFrom:'2099-01-01'}]) assert.equal((await post(ratePath,input)).status,400);
    assert.equal((await post(`${base}/bad/rates`,rate)).status,400);
    response=await post(ratePath,rate); assert.equal(response.status,201); assert.deepEqual(await response.json(),{data:{id:rateId}});
    assert.deepEqual(calls.pop(),['session-admin',categoryId,rate.effectiveFrom,123,requestKey]);
    for (const [outcome,status] of [['forbidden',403],['invalid-time',409],['not-found',404],['conflict',409]]) {result=outcome; assert.equal((await post(ratePath,rate)).status,status);}
    auth.catalog.addRate=async()=>{throw Error('database secret');}; response=await post(ratePath,rate); assert.equal(response.status,503); assert.ok(!(await response.text()).includes('secret'));
    identity={userId:undefined,cookies:[]}; assert.equal((await post(base,{name:'Paper'})).status,503);
  } finally { await new Promise(resolve=>server.close(resolve)); }
  const unavailable=createApp().listen(0,'127.0.0.1'); await once(unavailable,'listening');
  try { const res=await fetch(`http://127.0.0.1:${unavailable.address().port}/api/v1/admin/catalog/categories`,{method:'POST'}); assert.equal(res.status,503); assert.equal(res.headers.get('cache-control'),'no-store'); }
  finally { await new Promise(resolve=>unavailable.close(resolve)); }
});

test('catalog reads require session and admin, validate cursors, and project safe pages', async () => {
  const catId=randomUUID(), rateId=randomUUID(), calls=[];
  let identity={userId:'administrator',cookies:['fresh=1; HttpOnly']};
  let categories={categories:[{id:catId,name:'Test',active:true,createdBy:'hidden'}],nextAfter:null};
  let rates={rates:[{id:rateId,effectiveFrom:'2099-01-01T00:00:00.000Z',paisePerKg:123,createdBy:'hidden'}],nextAfter:null};
  const auth={origin:'http://localhost:3000',handler:async()=>{},resolveIdentity:async()=>identity,catalog:{
    listCategories:async (...args)=>{calls.push(args);return categories;},listRates:async (...args)=>{calls.push(args);return rates;}
  }};
  const server=createApp(auth).listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    const base=`http://127.0.0.1:${server.address().port}/api/v1/admin/catalog/categories`;
    for (const suffix of ['?after=bad','?other=1',`?after=${catId}&after=${catId}`,'?after[evil]=x']) assert.equal((await fetch(base+suffix)).status,400);
    assert.equal((await fetch(base+'/bad/rates')).status,400); assert.equal(calls.length,0);
    let res=await fetch(base,{headers:{'x-user-id':'forged','x-role':'admin'}});
    assert.equal(res.status,200); assert.equal(res.headers.get('cache-control'),'no-store'); assert.deepEqual(res.headers.getSetCookie(),['fresh=1; HttpOnly']);
    assert.deepEqual(await res.json(),{data:{categories:[{id:catId,name:'Test',active:true}],nextAfter:null}});
    assert.deepEqual(calls.pop(),['administrator',null]);
    res=await fetch(`${base}/${catId}/rates?after=${rateId}`); assert.equal(res.status,200);
    assert.deepEqual(await res.json(),{data:{rates:[{id:rateId,effectiveFrom:'2099-01-01T00:00:00.000Z',paisePerKg:123}],nextAfter:null}});
    assert.deepEqual(calls.pop(),['administrator',catId,rateId]);
    identity={userId:null,cookies:[]}; assert.equal((await fetch(base)).status,401);
    identity={userId:'administrator',cookies:[]}; categories='forbidden'; assert.equal((await fetch(base)).status,403);
    rates='forbidden'; assert.equal((await fetch(`${base}/${catId}/rates`)).status,403);
    rates='not-found'; assert.equal((await fetch(`${base}/${catId}/rates`)).status,404);
    categories={categories:[{id:'bad',name:'x',active:true}],nextAfter:null}; assert.equal((await fetch(base)).status,503);
    auth.catalog.listRates=async()=>{throw Error('database secret');}; res=await fetch(`${base}/${catId}/rates`); assert.equal(res.status,503); assert.ok(!(await res.text()).includes('secret'));
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
