// Component interaction tests in a DOM simulator; no Google or real users.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const require = createRequire(import.meta.url);
// Use the compiler shipped with pinned Next to execute the actual TSX in jsdom.
const babel = require('next/dist/compiled/babel/core');
const compiled = babel.transformSync(await readFile('apps/web/app/google-sign-in.tsx', 'utf8'), {
  filename: 'google-sign-in.tsx', babelrc: false, configFile: false,
  presets: [
    [require('next/dist/compiled/babel/preset-typescript'), { allExtensions: true, isTSX: true }],
    [require('next/dist/compiled/babel/preset-react'), { runtime: 'automatic' }],
  ],
  plugins: [require('next/dist/compiled/babel/plugin-transform-modules-commonjs')],
});
const temp = await mkdtemp(resolve('node_modules', 'auth-ui-test-'));
const modulePath = join(temp, 'component.cjs');
await writeFile(modulePath, compiled.code);
const pickupCompiled = babel.transformSync(await readFile('apps/web/app/test-pickups.tsx', 'utf8'), {
  filename: 'test-pickups.tsx', babelrc: false, configFile: false,
  presets: [[require('next/dist/compiled/babel/preset-typescript'), { allExtensions:true, isTSX:true }], [require('next/dist/compiled/babel/preset-react'), {runtime:'automatic'}]],
  plugins: [require('next/dist/compiled/babel/plugin-transform-modules-commonjs')],
});
await writeFile(join(temp, 'test-pickups.js'), pickupCompiled.code);
const catalogCompiled = babel.transformSync(await readFile('apps/web/app/catalog-viewer.tsx','utf8'), {
  filename:'catalog-viewer.tsx',babelrc:false,configFile:false,
  presets:[[require('next/dist/compiled/babel/preset-typescript'),{allExtensions:true,isTSX:true}],[require('next/dist/compiled/babel/preset-react'),{runtime:'automatic'}]],
  plugins:[require('next/dist/compiled/babel/plugin-transform-modules-commonjs')],
});
await writeFile(join(temp,'catalog-viewer.js'),catalogCompiled.code);
const adminCompiled = babel.transformSync(await readFile('apps/web/app/catalog-admin.tsx','utf8'), {
  filename:'catalog-admin.tsx',babelrc:false,configFile:false,
  presets:[[require('next/dist/compiled/babel/preset-typescript'),{allExtensions:true,isTSX:true}],[require('next/dist/compiled/babel/preset-react'),{runtime:'automatic'}]],
  plugins:[require('next/dist/compiled/babel/plugin-transform-modules-commonjs')],
});
await writeFile(join(temp,'catalog-admin.js'),adminCompiled.code);
const { GoogleSignIn } = createRequire(modulePath)(modulePath);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

test('Google sign-in component: session, errors, retry and sign-out', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:3000/' });
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import('react-dom/client');
  let root;
  const mount = async (mockFetch) => {
    globalThis.fetch = mockFetch;
    root = createRoot(document.getElementById('root'));
    await act(async () => { root.render(React.createElement(GoogleSignIn)); });
  };
  const unmount = async () => { await act(async () => root.unmount()); root = undefined; };
  const click = async () => { await act(async () => { document.querySelector('button').click(); }); };
  const clickButton = async text => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent === text);
    assert.ok(button, `button not found: ${text}`);
    await act(async () => { button.click(); });
  };
  try {
    await t.test('signed-out state and rejected unexpected sign-in redirect', async () => {
      const requests = [];
      await mount(async (url, init) => {
        requests.push([url, init]);
        return url.endsWith('get-session') ? json({ authenticated: false }) : json({ url: 'https://evil.example/' });
      });
      assert.equal(document.querySelector('button').textContent, 'Continue with Google');
      await click();
      assert.match(document.querySelector('[role="alert"]').textContent, /unavailable/i);
      assert.equal(requests[1][0], '/api/auth/sign-in/social');
      assert.equal(requests[1][1].method, 'POST');
      assert.deepEqual(JSON.parse(requests[1][1].body), { provider: 'google', callbackURL: '/' });
      await unmount();
    });
    await t.test('signed-in state and confirmed sign-out', async () => {
      let session = true;
      await mount(async (url, init) => {
        if (url.endsWith('sign-out')) {
          assert.equal(init.method, 'POST'); assert.equal(init.body, '{}'); session = false; return json({ success: true });
        }
        return json({ authenticated: session });
      });
      assert.match(document.body.textContent, /Signed in with Google/);
      assert.equal(document.querySelector('button').textContent, 'Sign out');
      await click();
      assert.equal(document.querySelector('button').textContent, 'Continue with Google');
      assert.doesNotMatch(document.body.textContent, /Signed in with Google/);
      await unmount();
    });
    await t.test('failed sign-out does not claim success', async () => {
      await mount(async (url) => url.endsWith('sign-out') ? json({}, 503) : json({ authenticated: true }));
      await click();
      assert.match(document.querySelector('[role="alert"]').textContent, /could not be confirmed/i);
      assert.equal(document.querySelector('button').textContent, 'Try again');
      await click();
      assert.equal(document.querySelector('button').textContent, 'Sign out');
      await unmount();
    });
    await t.test('unavailable or malformed session fails closed and can be retried', async () => {
      let calls = 0;
      await mount(async () => ++calls === 1 ? json({ authenticated: 'yes' }) : json({ authenticated: false }));
      assert.match(document.body.textContent, /Sign-in status is unavailable/);
      await click();
      assert.equal(document.querySelector('button').textContent, 'Continue with Google');
      await unmount();
    });
    await t.test('customer setup posts no identity or role and clears after sign-out', async () => {
      let session = true, calls = 0;
      await mount(async (url, init) => {
        if (url.endsWith('/account/customer')) {
          calls++; assert.equal(init.method, 'POST'); assert.equal(init.body, '{}');
          assert.equal(init.headers['Content-Type'], 'application/json');
          return json({ data: { customer: 'ready' } });
        }
        if (url.endsWith('sign-out')) { session = false; return json({ success: true }); }
        return json({ authenticated: session });
      });
      await clickButton('Set up customer account');
      assert.match(document.body.textContent, /Customer setup completed/);
      assert.equal(calls, 1);
      await clickButton('Set up customer account');
      assert.equal(calls, 2);
      await clickButton('Sign out');
      assert.doesNotMatch(document.body.textContent, /Customer setup completed|Set up customer account/);
      await unmount();
    });
    await t.test('customer setup errors fail closed and can be retried', async () => {
      let result = json({ error: { code: 'ACCOUNT_UNAVAILABLE' } }, 503);
      await mount(async url => url.endsWith('/account/customer') ? result : json({ authenticated: true }));
      await clickButton('Set up customer account');
      assert.match(document.querySelector('[role="alert"]').textContent, /could not be confirmed/i);
      assert.doesNotMatch(document.body.textContent, /Customer setup completed/);
      result = json({ error: { code: 'FORBIDDEN' } }, 403);
      await clickButton('Set up customer account');
      assert.match(document.querySelector('[role="alert"]').textContent, /not allowed/i);
      result = json({ data: { customer: 'wrong' } });
      await clickButton('Set up customer account');
      assert.match(document.querySelector('[role="alert"]').textContent, /could not be confirmed/i);
      result = new Response('not json', { status: 200 });
      await clickButton('Set up customer account');
      assert.match(document.querySelector('[role="alert"]').textContent, /could not be confirmed/i);
      result = json({ data: { customer: 'ready' } });
      await clickButton('Set up customer account');
      assert.match(document.body.textContent, /Customer setup completed/);
      assert.equal(document.querySelector('[role="alert"]'), null);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      await act(async () => { document.dispatchEvent(new dom.window.Event('visibilitychange')); });
      assert.doesNotMatch(document.body.textContent, /Customer setup completed/);
      delete document.visibilityState;
      await unmount();
    });
    await t.test('interrupted customer setup does not claim a result', async () => {
      await mount(async url => {
        if (url.endsWith('/account/customer')) throw new Error('synthetic network failure');
        return json({ authenticated: true });
      });
      await clickButton('Set up customer account');
      assert.match(document.querySelector('[role="alert"]').textContent, /could not be confirmed/i);
      assert.doesNotMatch(document.body.textContent, /Customer setup completed/);
      assert.ok(![...document.querySelectorAll('button')].some(item => item.disabled));
      await unmount();
    });
    await t.test('expired session requires a fresh sign-in check', async () => {
      let signedIn = true;
      await mount(async url => url.endsWith('/account/customer') ? json({ error: { code: 'SIGN_IN_REQUIRED' } }, 401) : json({ authenticated: signedIn }));
      await clickButton('Set up customer account');
      assert.match(document.body.textContent, /sign-in could not be confirmed/i);
      assert.doesNotMatch(document.body.textContent, /Customer setup completed/);
      signedIn = false;
      await clickButton('Try again');
      assert.equal(document.querySelector('button').textContent, 'Continue with Google');
      await unmount();
    });
    await t.test('hiding the tab discards an in-flight customer setup result', async () => {
      let finish;
      const pending = new Promise(resolve => { finish = resolve; });
      await mount(async url => url.endsWith('/account/customer') ? pending : json({ authenticated: true }));
      const button = [...document.querySelectorAll('button')].find(item => item.textContent === 'Set up customer account');
      await act(async () => { button.click(); });
      assert.ok([...document.querySelectorAll('button')].every(item => item.disabled));
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      await act(async () => { document.dispatchEvent(new dom.window.Event('visibilitychange')); });
      await act(async () => { finish(json({ data: { customer: 'ready' } })); await pending; });
      assert.doesNotMatch(document.body.textContent, /Customer setup completed/);
      delete document.visibilityState;
      await unmount();
    });
    await t.test('profile loads, saves and clears on sign-out', async () => {
      let session = true, saved;
      const profile = { name: 'Sample', addressLine: '12 Example', city: 'Ludhiana', state: 'Punjab', postalCode: '141001' };
      await mount(async (url, init) => {
        if (url.endsWith('/account/customer/details')) {
          if (init?.method === 'PUT') { saved = JSON.parse(init.body); return json({ data: { saved: true } }); }
          return json({ data: { details: profile } });
        }
        if (url.endsWith('/account/customer')) return json({ data: { customer: 'ready' } });
        if (url.endsWith('sign-out')) { session = false; return json({ success: true }); }
        return json({ authenticated: session });
      });
      await clickButton('Set up customer account'); await clickButton('Open customer profile');
      assert.equal(document.querySelector('[name="name"]').value, 'Sample');
      const input = document.querySelector('[name="name"]');
      await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, 'Changed'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
      await act(async () => { document.querySelector('form.customer-profile').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
      assert.deepEqual(saved, { ...profile, name: 'Changed' });
      assert.match(document.body.textContent, /Customer details saved/);
      await clickButton('Sign out');
      assert.equal(document.querySelector('form.customer-profile'), null);
      assert.doesNotMatch(document.body.textContent, /Customer details saved/);
      await unmount();
    });
    await t.test('profile errors and stale load results do not show personal data', async () => {
      let mode = 'bad'; let finish;
      const pending = new Promise(resolve => { finish = resolve; });
      await mount(async (url) => {
        if (url.endsWith('/account/customer/details')) return mode === 'bad' ? json({ data: { details: { name: 'Incomplete' } } }) : pending;
        if (url.endsWith('/account/customer')) return json({ data: { customer: 'ready' } });
        return json({ authenticated: true });
      });
      await clickButton('Set up customer account'); await clickButton('Open customer profile');
      assert.match(document.querySelector('[role="alert"]').textContent, /could not be loaded/i);
      assert.equal(document.querySelector('form.customer-profile'), null);
      mode = 'pending';
      await act(async () => { [...document.querySelectorAll('button')].find(item => item.textContent === 'Open customer profile').click(); });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      await act(async () => { document.dispatchEvent(new dom.window.Event('visibilitychange')); });
      await act(async () => { finish(json({ data: { details: { name: 'Sample', addressLine: 'Example', city: 'Ludhiana', state: 'Punjab', postalCode: '141001' } } })); await pending; });
      assert.equal(document.querySelector('form.customer-profile'), null);
      assert.doesNotMatch(document.body.textContent, /Customer setup completed/);
      delete document.visibilityState;
      await unmount();
    });
    await t.test('profile save failure and expired session fail closed', async () => {
      let mode = 'save-fail';
      await mount(async (url, init) => {
        if (url.endsWith('/account/customer/details')) {
          if (init?.method === 'PUT') return mode === 'save-fail' ? json({ error: { code: 'DETAILS_UNAVAILABLE' } }, 503) : json({ error: { code: 'SIGN_IN_REQUIRED' } }, 401);
          return json({ data: { details: { name: 'Sample', addressLine: 'Example', city: 'Ludhiana', state: 'Punjab', postalCode: '141001' } } });
        }
        if (url.endsWith('/account/customer')) return json({ data: { customer: 'ready' } });
        return json({ authenticated: true });
      });
      await clickButton('Set up customer account'); await clickButton('Open customer profile');
      await act(async () => { document.querySelector('form.customer-profile').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
      assert.match(document.querySelector('[role="alert"]').textContent, /could not be confirmed/i);
      assert.doesNotMatch(document.body.textContent, /Customer details saved/);
      mode = 'expired';
      await act(async () => { document.querySelector('form.customer-profile').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
      assert.equal(document.querySelector('form.customer-profile'), null);
      assert.match(document.body.textContent, /sign-in could not be confirmed/i);
      await unmount();
    });
    await t.test('test pickup retries an uncertain save with the same key and loads the list', async () => {
      const requests = []; let first = true;
      await mount(async (url, init) => {
        if (url.endsWith('/account/customer')) return json({data:{customer:'ready'}});
        if (url.endsWith('/customer/pickups')) {
          if (init?.method === 'POST') { requests.push(JSON.parse(init.body)); if (first) { first = false; throw Error('interrupted'); } return json({data:{created:true}}); }
          return json({data:{pickups:[]}});
        }
        return json({authenticated:true});
      });
      await clickButton('Set up customer account');
      const section = [...document.querySelectorAll('section')].find(el => el.textContent.includes('Test pickup requests'));
      const inputs = section.querySelectorAll('input');
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
        setter.call(inputs[0], 'Paper'); inputs[0].dispatchEvent(new dom.window.Event('input',{bubbles:true}));
        setter.call(inputs[1], '1500'); inputs[1].dispatchEvent(new dom.window.Event('input',{bubbles:true}));
      });
      await act(async () => {section.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));});
      assert.match(section.textContent, /could not be confirmed/i);
      await clickButton('Retry same test request');
      assert.deepEqual(requests[0], requests[1]); assert.equal(requests[0].estimatedGrams,1500);
      assert.match(section.textContent, /No collector will be notified/);
      await clickButton('Load my test requests'); assert.match(section.textContent, /No test requests found/);
      await unmount();
    });
    await t.test('read-only catalog loads pages and clears data on hidden tab', async () => {
      const category='123e4567-e89b-42d3-a456-426614174000', rate='123e4567-e89b-42d3-a456-426614174001';
      const paths=[];
      await mount(async (url,init) => {
        paths.push(url);
        if (url.endsWith('get-session')) return json({authenticated:true});
        assert.equal(init.cache,'no-store');
        if (url.endsWith('/rates')) return json({data:{rates:[{id:rate,effectiveFrom:'2099-01-01T00:00:00.000Z',paisePerKg:125}],nextAfter:null}});
        if (url.includes('?after=')) return json({data:{categories:[],nextAfter:null}});
        return json({data:{categories:[{id:category,name:'Synthetic paper',active:true}],nextAfter:category}});
      });
      await clickButton('Load test catalog'); assert.match(document.body.textContent,/Synthetic paper/);
      await clickButton('View rates for Synthetic paper'); assert.match(document.body.textContent,/₹1.25 per kg/);
      await clickButton('Next categories'); assert.match(document.body.textContent,/No categories on this page/);
      assert.ok(paths.some(p=>p.endsWith(`?after=${category}`)));
      await clickButton('Load test catalog');
      Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true});
      await act(async()=>document.dispatchEvent(new dom.window.Event('visibilitychange')));
      assert.doesNotMatch(document.body.textContent,/Synthetic paper/);
      Object.defineProperty(document,'visibilityState',{value:'visible',configurable:true});
      await unmount();
    });
    await t.test('admin catalog form retries an uncertain write with the same key and inputs', async () => {
      const category='123e4567-e89b-42d3-a456-426614174010';
      const writes=[];
      let failOnce=true;
      await mount(async (url,init) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (init?.method==='POST') {
          writes.push({url,headers:init.headers,body:JSON.parse(init.body)});
          if (failOnce) { failOnce=false; throw Error('interrupted'); }
          return json({data:{id:category}},201);
        }
        if (url.endsWith('/rates')) return json({data:{rates:[],nextAfter:null}});
        return json({data:{categories:[{id:category,name:'Synthetic metal',active:true}],nextAfter:null}});
      });
      const setValue=async (input,value)=>{ await act(async()=>{ Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(input,value); input.dispatchEvent(new dom.window.Event('input',{bubbles:true})); }); };
      const submit=async form=>{ await act(async()=>{ form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})); }); };
      await clickButton('Load test catalog');
      const admin=document.querySelector('.catalog-admin');
      assert.ok(admin,'admin form must render');
      assert.match(admin.textContent,/Choose “View rates”/);
      await setValue(admin.querySelector('input[name="categoryName"]'),' Synthetic cards ');
      await submit(admin.querySelectorAll('form')[0]);
      assert.match(admin.textContent,/could not be confirmed/i);
      await clickButton('Retry category save');
      assert.equal(writes.length,2);
      assert.equal(writes[0].body.name,'Synthetic cards');
      assert.deepEqual(writes[1].body,writes[0].body);
      assert.equal(writes[1].headers['Idempotency-Key'],writes[0].headers['Idempotency-Key']);
      assert.match(writes[0].headers['Idempotency-Key'],/^[0-9a-f]{8}-[0-9a-f]{4}-4/i);
      assert.match(admin.textContent,/Category saved/);
      assert.equal(admin.querySelector('input[name="categoryName"]').value,'');

      await clickButton('View rates for Synthetic metal');
      const rateForm=document.querySelectorAll('.catalog-admin form')[1];
      assert.ok(rateForm,'rate form appears only for a selected category');
      await setValue(rateForm.querySelector('input[name="rupeesPerKg"]'),'32.5');
      await submit(rateForm);
      const rateWrite=writes.at(-1);
      assert.equal(rateWrite.body.paisePerKg,3250);
      assert.match(rateWrite.url,new RegExp(`/categories/${category}/rates$`));
      assert.ok(Number.isFinite(Date.parse(rateWrite.body.effectiveFrom)));
      assert.match(document.querySelector('.catalog-admin').textContent,/Rate saved/);
      await unmount();
    });
    await t.test('admin catalog form never claims success on denial and rejects bad input locally', async () => {
      const posted=[];
      await mount(async (url,init) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (init?.method==='POST') { posted.push({body:init.body,key:init.headers['Idempotency-Key']}); return json({error:{code:'FORBIDDEN'}},403); }
        return json({data:{categories:[],nextAfter:null}});
      });
      const adminForm=()=>document.querySelector('.catalog-admin');
      const setValue=async (input,value)=>{ await act(async()=>{ Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(input,value); input.dispatchEvent(new dom.window.Event('input',{bubbles:true})); }); };
      await clickButton('Load test catalog');
      const input=adminForm().querySelector('input[name="categoryName"]');
      await setValue(input,'  ');
      await act(async()=>{ adminForm().querySelectorAll('form')[0].dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})); });
      assert.equal(posted.length,0,'blank names must not be sent');
      assert.match(adminForm().textContent,/up to 100 characters/i);
      await setValue(input,'Synthetic denial');
      await act(async()=>{ adminForm().querySelectorAll('form')[0].dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})); });
      assert.equal(posted.length,1);
      assert.match(adminForm().textContent,/Admin access is required/);
      assert.doesNotMatch(adminForm().textContent,/saved/i);
      assert.equal([...document.querySelectorAll('button')].some(x=>x.textContent==='Retry category save'),false,'denial must not leave a retry state');
      await unmount();
    });
    await t.test('admin catalog form discards an in-flight write when the tab hides', async () => {
      let finish;
      const pending=new Promise(resolve=>{finish=resolve;});
      await mount(async (url,init) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (init?.method==='POST') return pending;
        return json({data:{categories:[],nextAfter:null}});
      });
      await clickButton('Load test catalog');
      const admin=document.querySelector('.catalog-admin');
      await act(async()=>{ Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(admin.querySelector('input[name="categoryName"]'),'Hidden write'); admin.querySelector('input[name="categoryName"]').dispatchEvent(new dom.window.Event('input',{bubbles:true})); });
      await act(async()=>{ admin.querySelectorAll('form')[0].dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})); });
      Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true});
      await act(async()=>{ document.dispatchEvent(new dom.window.Event('visibilitychange')); });
      await act(async()=>{ finish(json({data:{id:'123e4567-e89b-42d3-a456-426614174011'}},201)); await pending; });
      assert.doesNotMatch(document.querySelector('.catalog-admin').textContent,/Category saved/);
      assert.equal([...document.querySelectorAll('button')].some(x=>x.textContent==='Retry category save'),false);
      Object.defineProperty(document,'visibilityState',{value:'visible',configurable:true});
      await unmount();
    });
    await t.test('catalog denies access and ignores a stale in-flight result', async () => {
      let resolveCatalog;
      await mount(async url => url.endsWith('get-session') ? json({authenticated:true}) : new Promise(resolve=>{resolveCatalog=resolve;}));
      const button=[...document.querySelectorAll('button')].find(x=>x.textContent==='Load test catalog');
      await act(async()=>{button.click();});
      Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true});
      await act(async()=>document.dispatchEvent(new dom.window.Event('visibilitychange')));
      await act(async()=>resolveCatalog(json({data:{categories:[{id:'123e4567-e89b-42d3-a456-426614174000',name:'Stale data',active:true}],nextAfter:null}})));
      assert.doesNotMatch(document.body.textContent,/Stale data/);
      Object.defineProperty(document,'visibilityState',{value:'visible',configurable:true});
      globalThis.fetch=async()=>json({error:{code:'FORBIDDEN'}},403);
      await clickButton('Load test catalog'); assert.match(document.body.textContent,/Admin access is required/);
      await unmount();
    });
    await t.test('a still-active session after sign-out is not presented as signed out', async () => {
      await mount(async (url) => url.endsWith('sign-out') ? json({ success: true }) : json({ authenticated: true }));
      await click();
      assert.equal(document.querySelector('button').textContent, 'Sign out');
      assert.match(document.querySelector('[role="alert"]').textContent, /could not be confirmed/i);
      await unmount();
    });
  } finally {
    if (root) await unmount();
    dom.window.close();
    globalThis.window = previous.window; globalThis.document = previous.document; globalThis.fetch = previous.fetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    await rm(temp, { recursive: true, force: true });
  }
});
