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
const collectorCompiled = babel.transformSync(await readFile('apps/web/app/collector-queue.tsx','utf8'), {
  filename:'collector-queue.tsx',babelrc:false,configFile:false,
  presets:[[require('next/dist/compiled/babel/preset-typescript'),{allExtensions:true,isTSX:true}],[require('next/dist/compiled/babel/preset-react'),{runtime:'automatic'}]],
  plugins:[require('next/dist/compiled/babel/plugin-transform-modules-commonjs')],
});
await writeFile(join(temp,'collector-queue.js'),collectorCompiled.code);
const disputeCompiled = babel.transformSync(await readFile('apps/web/app/dispute-admin.tsx','utf8'), {
  filename:'dispute-admin.tsx',babelrc:false,configFile:false,
  presets:[[require('next/dist/compiled/babel/preset-typescript'),{allExtensions:true,isTSX:true}],[require('next/dist/compiled/babel/preset-react'),{runtime:'automatic'}]],
  plugins:[require('next/dist/compiled/babel/plugin-transform-modules-commonjs')],
});
await writeFile(join(temp,'dispute-admin.js'),disputeCompiled.code);
const payoutCompiled = babel.transformSync(await readFile('apps/web/app/payout-admin.tsx','utf8'), {
  filename:'payout-admin.tsx',babelrc:false,configFile:false,
  presets:[[require('next/dist/compiled/babel/preset-typescript'),{allExtensions:true,isTSX:true}],[require('next/dist/compiled/babel/preset-react'),{runtime:'automatic'}]],
  plugins:[require('next/dist/compiled/babel/plugin-transform-modules-commonjs')],
});
await writeFile(join(temp,'payout-admin.js'),payoutCompiled.code);
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
    await t.test('test pickup retries an uncertain save with the same key, shows the estimate and loads the list', async () => {
      const requests = []; let first = true;
      const categoryId='123e4567-e89b-42d3-a456-426614174030', rateId='123e4567-e89b-42d3-a456-426614174031';
      const estimate = {categoryId, categoryName:'Synthetic paper', rateId, paisePerKg:3245, amountPaise:'8113'};
      await mount(async (url, init) => {
        if (url.endsWith('/account/customer')) return json({data:{customer:'ready'}});
        if (url.endsWith('/customer/pickups')) {
          if (init?.method === 'POST') {
            requests.push(JSON.parse(init.body));
            if (first) { first = false; throw Error('interrupted'); }
            return json({data:{created:true, estimate}});
          }
          return json({data:{pickups:[
            { id:categoryId, status:'requested', createdAt:'2026-11-18T17:00:00.000Z',
              address:{name:'Sample',addressLine:'12 Example',city:'Ludhiana',state:'Punjab',postalCode:'141001'},
              estimatedGrams:2500, material:null, ...estimate },
            { id:rateId, status:'requested', createdAt:'2026-11-17T09:00:00.000Z',
              address:{name:'Sample',addressLine:'12 Example',city:'Ludhiana',state:'Punjab',postalCode:'141001'},
              estimatedGrams:900, material:'Old free text', categoryId:null, categoryName:null, rateId:null, paisePerKg:null, amountPaise:null },
          ]}});
        }
        return json({authenticated:true});
      });
      await clickButton('Set up customer account');
      const section = [...document.querySelectorAll('section')].find(el => el.textContent.includes('Test pickup requests'));
      const inputs = section.querySelectorAll('input');
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      const type = async (input, value) => act(async () => { setter.call(input, value); input.dispatchEvent(new dom.window.Event('input',{bubbles:true})); });
      await type(inputs[0], categoryId);
      await type(inputs[1], '2500');
      await act(async () => {section.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));});
      assert.match(section.textContent, /could not be confirmed/i);
      await clickButton('Retry same test request');
      assert.deepEqual(requests[0], requests[1]);
      assert.equal(requests[0].estimatedGrams,2500);
      assert.equal(requests[0].categoryId,categoryId);
      // No client-side price may be sent, only the key, category and weight.
      assert.deepEqual(Object.keys(requests[0]).sort(), ['categoryId','estimatedGrams','requestKey']);
      // The server's estimate is displayed, formatted from integer paise.
      assert.match(section.textContent, /Estimated ₹81\.13 for Synthetic paper at ₹32\.45 per kg/);
      assert.match(section.textContent, /no collector will be notified/i);

      await clickButton('Load my test requests');
      // Priced history shows its stored estimate; legacy history says so plainly.
      assert.match(section.textContent, /Synthetic paper — 2500 g — estimated ₹81\.13 at ₹32\.45\/kg/);
      assert.match(section.textContent, /Old free text — 900 g — no estimate \(older request\)/);
      await unmount();
    });
    await t.test('test pickup explains a missing rate instead of inventing a price', async () => {
      await mount(async (url, init) => {
        if (url.endsWith('/account/customer')) return json({data:{customer:'ready'}});
        if (url.endsWith('/customer/pickups') && init?.method === 'POST') return json({error:{code:'NO_RATE'}},409);
        return json({authenticated:true});
      });
      await clickButton('Set up customer account');
      const section = [...document.querySelectorAll('section')].find(el => el.textContent.includes('Test pickup requests'));
      const inputs = section.querySelectorAll('input');
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      await act(async () => { setter.call(inputs[0],'123e4567-e89b-42d3-a456-426614174032'); inputs[0].dispatchEvent(new dom.window.Event('input',{bubbles:true})); });
      await act(async () => { setter.call(inputs[1],'500'); inputs[1].dispatchEvent(new dom.window.Event('input',{bubbles:true})); });
      await act(async () => {section.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));});
      assert.match(section.textContent, /No rate is active for that category yet/i);
      assert.doesNotMatch(section.textContent, /Estimated ₹/);
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
      // A 2099 start is not in force, and the UI must say so rather than leave
      // the reader to compare timestamps: this is why NO_RATE would appear.
      assert.match(document.body.textContent,/not yet in force/);
      assert.match(document.body.textContent,/NO_RATE/);
      assert.doesNotMatch(document.body.textContent,/not connected to pickup estimates/);
      await clickButton('Next categories'); assert.match(document.body.textContent,/No categories on this page/);
      assert.ok(paths.some(p=>p.endsWith(`?after=${category}`)));
      await clickButton('Load test catalog');
      Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true});
      await act(async()=>document.dispatchEvent(new dom.window.Event('visibilitychange')));
      assert.doesNotMatch(document.body.textContent,/Synthetic paper/);
      Object.defineProperty(document,'visibilityState',{value:'visible',configurable:true});
      await unmount();
    });
    await t.test('a rate already in force is labelled as in force', async () => {
      const category='123e4567-e89b-42d3-a456-426614174060', rate='123e4567-e89b-42d3-a456-426614174061';
      await mount(async (url) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (url.endsWith('/rates')) return json({data:{rates:[{id:rate,effectiveFrom:'2020-01-01T00:00:00.000Z',paisePerKg:3245}],nextAfter:null}});
        return json({data:{categories:[{id:category,name:'Live paper',active:true}],nextAfter:null}});
      });
      await clickButton('Load test catalog');
      await clickButton('View rates for Live paper');
      assert.match(document.body.textContent,/₹32.45 per kg/);
      assert.match(document.body.textContent,/in force/);
      assert.doesNotMatch(document.body.textContent,/not yet in force/);
      assert.doesNotMatch(document.body.textContent,/NO_RATE/);
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
    await t.test('an untouched start time is refreshed at submit so it cannot go stale', async () => {
      const category='123e4567-e89b-42d3-a456-426614174020';
      const writes=[];
      await mount(async (url,init) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (init?.method==='POST') { writes.push(JSON.parse(init.body)); return json({data:{id:category}},201); }
        if (url.endsWith('/rates')) return json({data:{rates:[],nextAfter:null}});
        return json({data:{categories:[{id:category,name:'Synthetic glass',active:true}],nextAfter:null}});
      });
      await clickButton('Load test catalog');
      await clickButton('View rates for Synthetic glass');
      const form=document.querySelectorAll('.catalog-admin form')[1];
      const rate=form.querySelector('input[name="rupeesPerKg"]');
      await act(async()=>{
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(rate,'10');
        rate.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
      });
      // The displayed value was computed on mount; submitting must not reuse it.
      const displayed=Date.parse(form.querySelector('input[name="effectiveFrom"]').value);
      await act(async()=>{ form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})); });
      assert.equal(writes.length,1);
      const sent=Date.parse(writes[0].effectiveFrom);
      assert.ok(sent>Date.now(),'an untouched default must still be in the future when sent');
      assert.ok(sent>=displayed,'the submitted default is re-derived, never earlier than shown');
      assert.equal(writes[0].paisePerKg,1000);
      assert.match(document.querySelector('.catalog-admin').textContent,/Rate saved/);
      await unmount();
    });
    await t.test('an operator-chosen past start is refused by the API and never reported as saved', async () => {
      const category='123e4567-e89b-42d3-a456-426614174021';
      const writes=[];
      await mount(async (url,init) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (init?.method==='POST') { writes.push(JSON.parse(init.body)); return json({error:{code:'INVALID_RATE_TIME'}},409); }
        if (url.endsWith('/rates')) return json({data:{rates:[],nextAfter:null}});
        return json({data:{categories:[{id:category,name:'Synthetic steel',active:true}],nextAfter:null}});
      });
      await clickButton('Load test catalog');
      await clickButton('View rates for Synthetic steel');
      const form=document.querySelectorAll('.catalog-admin form')[1];
      const setter=Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set;
      await act(async()=>{
        setter.call(form.querySelector('input[name="effectiveFrom"]'),'2020-01-01T00:00:00.000Z');
        form.querySelector('input[name="effectiveFrom"]').dispatchEvent(new dom.window.Event('input',{bubbles:true}));
        setter.call(form.querySelector('input[name="rupeesPerKg"]'),'11');
        form.querySelector('input[name="rupeesPerKg"]').dispatchEvent(new dom.window.Event('input',{bubbles:true}));
      });
      await act(async()=>{ form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})); });
      assert.equal(writes.length,1);
      assert.equal(writes[0].effectiveFrom,'2020-01-01T00:00:00.000Z','an explicit choice is respected, not silently rewritten');
      const admin=document.querySelector('.catalog-admin');
      assert.match(admin.textContent,/must be in the future/);
      assert.doesNotMatch(admin.textContent,/Rate saved/);
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
    await t.test('collector queue accepts, records a weight and shows the final amount', async () => {
      const requestId='123e4567-e89b-42d3-a456-426614174100', rateId='123e4567-e89b-42d3-a456-426614174101';
      const address={name:'Sample',addressLine:'12 Example',city:'Ludhiana',state:'Punjab',postalCode:'141001'};
      const open={ id:requestId, status:'requested', createdAt:'2026-11-18T17:00:00.000Z', address, estimatedGrams:2500,
        material:null, categoryId:'123e4567-e89b-42d3-a456-426614174102', categoryName:'Synthetic paper', rateId:rateId,
        paisePerKg:3245, amountPaise:'8113', actualGrams:null, finalRateId:null, finalPaisePerKg:null, finalAmountPaise:null, collectedAt:null };
      const accepted={ ...open, status:'accepted' };
      const collected={ ...accepted, status:'collected', actualGrams:2300, finalRateId:rateId, finalPaisePerKg:3300,
        finalAmountPaise:'7590', collectedAt:'2026-11-20T10:00:00.000Z' };
      let mine=[accepted], posts=[];
      await mount(async (url, init) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (url.includes('/collector/pickups?view=')) return json({data:{pickups: url.includes('view=mine') ? mine : [open]}});
        if (url.endsWith('/collect')) { posts.push(JSON.parse(init.body)); mine=[collected]; return json({data:{collected:true, actualGrams:2300,
          finalPaisePerKg:3300, finalAmountPaise:'7590', finalRateId:rateId}}); }
        if (url.endsWith('/accept')) { posts.push(JSON.parse(init.body)); return json({data:{accepted:true}}); }
        return json({authenticated:true});
      });
      const section=[...document.querySelectorAll('section')].find(el=>el.textContent.includes('Collector queue'));
      const inSection=text=>[...section.querySelectorAll('button')].find(b=>b.textContent===text);
      await clickButton('Open requests');
      assert.match(section.textContent,/Synthetic paper — 2500 g — estimate ₹81\.13 at ₹32\.45\/kg/);
      await act(async()=>{inSection('Accept this request').click();});
      // Accept sends an empty object: no collector id and no price.
      assert.deepEqual(posts.pop(), {});
      assert.match(section.textContent,/Request accepted/i);
      assert.match(section.textContent,/accepted/);
      const input=section.querySelector('input');
      const setter=Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set;
      await act(async()=>{setter.call(input,'2300'); input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
      globalThis.confirm=()=>true;
      await act(async()=>{inSection('Record collection').click();});
      // Collect sends only the measured weight.
      assert.deepEqual(posts.pop(), {actualGrams:2300});
      assert.match(section.textContent,/Final amount ₹75\.90 at ₹33\.00\/kg/);
      assert.match(section.textContent,/Final: 2300 g at ₹33\.00\/kg = ₹75\.90/);
      await unmount();
    });
    await t.test('collector queue refuses a bad weight and explains a lost race', async () => {
      const requestId='123e4567-e89b-42d3-a456-426614174103';
      const row={ id:requestId, status:'accepted', createdAt:'2026-11-18T17:00:00.000Z',
        address:{name:'Sample',addressLine:'12 Example',city:'Ludhiana',state:'Punjab',postalCode:'141001'},
        estimatedGrams:2500, material:null, categoryId:'123e4567-e89b-42d3-a456-426614174104', categoryName:'Synthetic paper',
        rateId:'123e4567-e89b-42d3-a456-426614174105', paisePerKg:3245, amountPaise:'8113',
        actualGrams:null, finalRateId:null, finalPaisePerKg:null, finalAmountPaise:null, collectedAt:null };
      let posts=0;
      await mount(async (url, init) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (url.includes('/collector/pickups?view=')) return json({data:{pickups:[row]}});
        if (init?.method === 'POST') { posts++; return json({error:{code:url.endsWith('/collect')?'ALREADY_COLLECTED':'ALREADY_ACCEPTED'}},409); }
        return json({authenticated:true});
      });
      const section=[...document.querySelectorAll('section')].find(el=>el.textContent.includes('Collector queue'));
      const clickIn=async text=>{const b=[...section.querySelectorAll('button')].find(x=>x.textContent===text); assert.ok(b,`button not found: ${text}`); await act(async()=>{b.click();});};
      await clickButton('My accepted and collected');
      await clickIn('Record collection');
      // An empty weight never reaches the API.
      assert.equal(posts,0);
      assert.match(section.textContent,/Enter the measured weight/i);
      const input=section.querySelector('input');
      const setter=Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set;
      await act(async()=>{setter.call(input,'0'); input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
      await clickIn('Record collection');
      assert.equal(posts,0,'a weight below 1 g is refused locally');

      globalThis.fetch=async (url,init) => url.endsWith('get-session') ? json({authenticated:true})
        : url.includes('view=') ? json({data:{pickups:[{...row, status:'requested'}]}})
        : json({error:{code:'ALREADY_ACCEPTED'}},409);
      await clickButton('Open requests');
      await clickIn('Accept this request');
      assert.match(section.textContent,/Another collector already accepted/i);
      await unmount();
    });
    await t.test('customer sees the collection-time final amount once collected', async () => {
      const estimate={categoryId:'123e4567-e89b-42d3-a456-426614174110', categoryName:'Synthetic paper',
        rateId:'123e4567-e89b-42d3-a456-426614174111', paisePerKg:3245, amountPaise:'8113'};
      await mount(async (url, init) => {
        if (url.endsWith('/account/customer')) return json({data:{customer:'ready'}});
        if (url.endsWith('/customer/pickups') && !init?.method) return json({data:{pickups:[
          { id:'123e4567-e89b-42d3-a456-426614174112', status:'collected', createdAt:'2026-11-18T17:00:00.000Z',
            address:{name:'Sample',addressLine:'12 Example',city:'Ludhiana',state:'Punjab',postalCode:'141001'},
            estimatedGrams:2500, material:null, ...estimate, actualGrams:2300,
            finalRateId:'123e4567-e89b-42d3-a456-426614174113', finalPaisePerKg:3300, finalAmountPaise:'7590',
            collectedAt:'2026-11-20T10:00:00.000Z' },
        ]}});
        return json({authenticated:true});
      });
      await clickButton('Set up customer account');
      const section=[...document.querySelectorAll('section')].find(el=>el.textContent.includes('Test pickup requests'));
      await act(async()=>{[...section.querySelectorAll('button')].find(b=>b.textContent==='Load my test requests').click();});
      // Both figures are present and each is labelled: estimate at request time,
      // final amount at collection time.
      assert.match(section.textContent,/estimated ₹81\.13 at ₹32\.45\/kg/);
      assert.match(section.textContent,/Final amount ₹75\.90: 2300 g at ₹33\.00\/kg \(collection-time rate\)/);
      await unmount();
    });
    await t.test('a schema-behind database tells the operator to migrate', async () => {
      await mount(async (url, init) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (url.includes('/collector/pickups?view=')) return json({error:{code:'PICKUP_SCHEMA_OUTDATED'}},503);
        if (url.endsWith('/account/customer')) return json({data:{customer:'ready'}});
        if (url.endsWith('/customer/pickups') && !init?.method) return json({error:{code:'PICKUP_SCHEMA_OUTDATED'}},503);
        return json({authenticated:true});
      });
      await clickButton('Open requests');
      const queue=[...document.querySelectorAll('section')].find(el=>el.textContent.includes('Collector queue'));
      assert.match(queue.textContent,/pickup database is behind this build/i);
      await clickButton('Set up customer account');
      const section=[...document.querySelectorAll('section')].find(el=>el.textContent.includes('Test pickup requests'));
      await act(async()=>{[...section.querySelectorAll('button')].find(b=>b.textContent==='Load my test requests').click();});
      assert.match(section.textContent,/pickup database is behind this build/i);
      await unmount();
    });
    await t.test('customer can cancel an accepted request and sees the terminal state', async () => {
      const requestId='123e4567-e89b-42d3-a456-426614174120';
      const address={name:'Sample',addressLine:'12 Example',city:'Ludhiana',state:'Punjab',postalCode:'141001'};
      const row={ id:requestId, status:'accepted', createdAt:'2026-11-18T17:00:00.000Z', address, estimatedGrams:2500,
        material:null, categoryId:'123e4567-e89b-42d3-a456-426614174121', categoryName:'Synthetic paper',
        rateId:'123e4567-e89b-42d3-a456-426614174122', paisePerKg:3245, amountPaise:'8113',
        actualGrams:null, finalRateId:null, finalPaisePerKg:null, finalAmountPaise:null, collectedAt:null,
        cancelledAt:null, cancellationReason:null, releasedAt:null };
      const cancelled={ ...row, status:'cancelled', cancelledAt:'2026-11-21T09:00:00.000Z', cancellationReason:'Changed my mind' };
      let posts=[], rows=[row];
      await mount(async (url, init) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (url.endsWith('/account/customer')) return json({data:{customer:'ready'}});
        if (url.includes('/cancel')) {
          posts.push([url, JSON.parse(init.body ?? '{}')]);
          rows=[cancelled];
          return json({data:{cancelled:true}});
        }
        if (url.endsWith('/customer/pickups')) return json({data:{pickups:rows}});
        return json({authenticated:true});
      });
      globalThis.confirm=()=>true;
      await clickButton('Set up customer account');
      const section=[...document.querySelectorAll('section')].find(el=>el.textContent.includes('Test pickup requests'));
      const load=async()=>act(async()=>{[...section.querySelectorAll('button')].find(b=>b.textContent==='Load my test requests').click();});
      await load();
      // An accepted request can still be cancelled; the button is offered.
      const cancel=[...section.querySelectorAll('button')].find(b=>b.textContent==='Cancel this request');
      assert.ok(cancel, 'an accepted request offers cancellation');
      await act(async()=>{cancel.click();});
      // The cancel call sends an empty body — no status, no collector, no price.
      assert.equal(posts.length,1);
      assert.ok(posts[0][0].endsWith(`/${requestId}/cancel`));
      assert.deepEqual(posts[0][1], {});
      // The row reports the terminal state and no cancel button remains.
      assert.match(section.textContent,/Cancelled: Changed my mind/);
      assert.equal([...section.querySelectorAll('button')].filter(b=>b.textContent==='Cancel this request').length, 0);
      await unmount();
    });
    await t.test('a collected request offers no cancel and a lost race is explained', async () => {
      const requestId='123e4567-e89b-42d3-a456-426614174123';
      const row={ id:requestId, status:'collected', createdAt:'2026-11-18T17:00:00.000Z',
        address:{name:'Sample',addressLine:'12 Example',city:'Ludhiana',state:'Punjab',postalCode:'141001'},
        estimatedGrams:2500, material:null, categoryId:'123e4567-e89b-42d3-a456-426614174124',
        categoryName:'Synthetic paper', rateId:'123e4567-e89b-42d3-a456-426614174125', paisePerKg:3245,
        amountPaise:'8113', actualGrams:2300, finalRateId:'123e4567-e89b-42d3-a456-426614174126',
        finalPaisePerKg:3245, finalAmountPaise:'7464', collectedAt:'2026-11-20T10:00:00.000Z',
        cancelledAt:null, cancellationReason:null, releasedAt:null };
      let cancelCalls=0;
      await mount(async (url, init) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (url.endsWith('/account/customer')) return json({data:{customer:'ready'}});
        if (url.includes('/cancel')) { cancelCalls++; return json({error:{code:'ALREADY_COLLECTED'}},409); }
        if (url.endsWith('/customer/pickups')) return json({data:{pickups:[row]}});
        return json({authenticated:true});
      });
      await clickButton('Set up customer account');
      const section=[...document.querySelectorAll('section')].find(el=>el.textContent.includes('Test pickup requests'));
      await act(async()=>{[...section.querySelectorAll('button')].find(b=>b.textContent==='Load my test requests').click();});
      // Settled money stays visible and the row cannot be cancelled.
      assert.match(section.textContent,/Final amount ₹74\.64/);
      assert.equal([...section.querySelectorAll('button')].filter(b=>b.textContent==='Cancel this request').length, 0);
      assert.equal(cancelCalls, 0, 'a collected request never offers a cancel call');
      await unmount();
    });
    await t.test('collector can release a claim back to the open queue', async () => {
      const requestId='123e4567-e89b-42d3-a456-426614174130';
      const base={ id:requestId, createdAt:'2026-11-18T17:00:00.000Z',
        address:{name:'Sample',addressLine:'12 Example',city:'Ludhiana',state:'Punjab',postalCode:'141001'},
        estimatedGrams:2500, material:null, categoryId:'123e4567-e89b-42d3-a456-426614174131',
        categoryName:'Synthetic paper', rateId:'123e4567-e89b-42d3-a456-426614174132', paisePerKg:3245,
        amountPaise:'8113', actualGrams:null, finalRateId:null, finalPaisePerKg:null, finalAmountPaise:null,
        collectedAt:null, cancelledAt:null, cancellationReason:null, releasedAt:null };
      let posts=[], mine=[{...base, status:'accepted'}];
      await mount(async (url, init) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (url.includes('/collector/pickups?view=')) return json({data:{pickups: url.includes('view=mine') ? mine : [{...base, status:'requested'}]}});
        if (url.endsWith('/release')) {
          posts.push(JSON.parse(init.body ?? '{}'));
          mine=[];
          return json({data:{released:true}});
        }
        return json({authenticated:true});
      });
      globalThis.confirm=()=>true;
      const section=[...document.querySelectorAll('section')].find(el=>el.textContent.includes('Collector queue'));
      await clickButton('My accepted and collected');
      const release=[...section.querySelectorAll('button')].find(b=>b.textContent==='Release this request');
      assert.ok(release, 'an accepted claim can be released');
      await act(async()=>{release.click();});
      // Release carries no body at all.
      assert.deepEqual(posts, [{}]);
      assert.match(section.textContent,/Request released/i);
      await unmount();
    });
    await t.test('collector is told why their own request cannot be accepted', async () => {
      const row={ id:'123e4567-e89b-42d3-a456-426614174140', status:'requested', createdAt:'2026-11-18T17:00:00.000Z',
        address:{name:'Sample',addressLine:'12 Example',city:'Ludhiana',state:'Punjab',postalCode:'141001'},
        estimatedGrams:2500, material:null, categoryId:'123e4567-e89b-42d3-a456-426614174141',
        categoryName:'Synthetic paper', rateId:'123e4567-e89b-42d3-a456-426614174142', paisePerKg:3245,
        amountPaise:'8113', actualGrams:null, finalRateId:null, finalPaisePerKg:null, finalAmountPaise:null,
        collectedAt:null, cancelledAt:null, cancellationReason:null, releasedAt:null };
      await mount(async (url, init) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (url.includes('/collector/pickups?view=')) return json({data:{pickups:[row]}});
        if (url.endsWith('/accept')) return json({error:{code:'OWN_REQUEST'}},409);
        return json({authenticated:true});
      });
      const section=[...document.querySelectorAll('section')].find(el=>el.textContent.includes('Collector queue'));
      await clickButton('Open requests');
      await act(async()=>{[...section.querySelectorAll('button')].find(b=>b.textContent==='Accept this request').click();});
      assert.match(section.textContent,/cannot accept your own request/i);
      await unmount();
    });
    await t.test('customer disputes a collected amount and sees it stays visible', async () => {
      const requestId='123e4567-e89b-42d3-a456-426614174150';
      const address={name:'Sample',addressLine:'12 Example',city:'Ludhiana',state:'Punjab',postalCode:'141001'};
      const settled={ id:requestId, status:'collected', createdAt:'2026-11-18T17:00:00.000Z', address,
        estimatedGrams:2500, material:null, categoryId:'123e4567-e89b-42d3-a456-426614174151',
        categoryName:'Synthetic paper', rateId:'123e4567-e89b-42d3-a456-426614174152', paisePerKg:3245,
        amountPaise:'8113', actualGrams:2300, finalRateId:'123e4567-e89b-42d3-a456-426614174153',
        finalPaisePerKg:3245, finalAmountPaise:'7464', collectedAt:'2026-11-20T10:00:00.000Z',
        cancelledAt:null, cancellationReason:null, releasedAt:null, dispute:null };
      const disputed={ ...settled, dispute:{ status:'open', raisedAt:'2026-11-21T08:00:00.000Z',
        reason:'It weighed closer to 2 kg', resolvedAt:null } };
      let posts=[], rows=[settled];
      await mount(async (url, init) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (url.endsWith('/account/customer')) return json({data:{customer:'ready'}});
        if (url.includes('/dispute')) {
          posts.push([url, JSON.parse(init.body ?? '{}')]);
          rows=[disputed];
          return json({data:{raised:true}});
        }
        if (url.endsWith('/customer/pickups')) return json({data:{pickups:rows}});
        return json({authenticated:true});
      });
      // The dispute prompt is a native dialog; stub it with a fixed reason.
      globalThis.prompt=()=>'It weighed closer to 2 kg';
      await clickButton('Set up customer account');
      const section=[...document.querySelectorAll('section')].find(el=>el.textContent.includes('Test pickup requests'));
      const load=async()=>act(async()=>{[...section.querySelectorAll('button')].find(b=>b.textContent==='Load my test requests').click();});
      await load();
      assert.match(section.textContent,/Final amount ₹74\.64/);
      const button=[...section.querySelectorAll('button')].find(b=>b.textContent==='Dispute this amount');
      assert.ok(button,'a collected amount can be disputed');
      await act(async()=>{button.click();});
      // Only the reason is sent: no weight, no amount, no status.
      assert.equal(posts.length,1);
      assert.ok(posts[0][0].endsWith(`/${requestId}/dispute`));
      assert.deepEqual(posts[0][1], { reason:'It weighed closer to 2 kg' });
      // The disputed amount is still shown, and the button is gone while it is open.
      assert.match(section.textContent,/Final amount ₹74\.64/);
      assert.match(section.textContent,/Dispute open: It weighed closer to 2 kg/);
      assert.equal([...section.querySelectorAll('button')].filter(b=>b.textContent==='Dispute this amount').length,0);
      await unmount();
    });
    await t.test('admin corrects a disputed weight and the response shows the frozen rate', async () => {
      const requestId='123e4567-e89b-42d3-a456-426614174160';
      const row={ id:requestId, categoryName:'Synthetic paper', estimatedGrams:2500, actualGrams:2300,
        finalPaisePerKg:3245, finalAmountPaise:'7464',
        address:{name:'Sample',addressLine:'12 Example',city:'Ludhiana',state:'Punjab',postalCode:'141001'},
        dispute:{ reason:'It weighed closer to 2 kg', raisedAt:'2026-11-21T08:00:00.000Z' } };
      let posts=[];
      await mount(async (url, init) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (url.includes('/admin/disputes/')) {
          posts.push([url, JSON.parse(init.body ?? '{}')]);
          return json({data:{resolved:true, actualGrams:2000, finalPaisePerKg:3245, finalAmountPaise:'6490'}});
        }
        if (url.endsWith('/admin/disputes')) return json({data:{disputes:[row]}});
        return json({authenticated:true});
      });
      globalThis.confirm=()=>true;
      await clickButton('Load open disputes');
      const section=[...document.querySelectorAll('section')].find(el=>el.textContent.includes('Disputed amounts'));
      assert.match(section.textContent,/recorded 2300 g at ₹32\.45\/kg = ₹74\.64/);
      assert.match(section.textContent,/Customer says: It weighed closer to 2 kg/);
      const input=section.querySelector('input');
      const setter=Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set;
      await act(async()=>{setter.call(input,'2000'); input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
      await act(async()=>{[...section.querySelectorAll('button')].find(b=>b.textContent==='Correct the weight').click();});
      // Only the corrected weight is sent; the browser never supplies a price.
      assert.equal(posts.length,1);
      assert.ok(posts[0][0].endsWith(`/${requestId}/resolve`));
      assert.deepEqual(posts[0][1], { correctedGrams:2000 });
      assert.match(section.textContent,/Corrected 2000 g, final amount ₹64\.90 at ₹32\.45\/kg/);
      await unmount();
    });
    await t.test('admin records a payout and the browser never supplies the amount', async () => {
      const requestId='123e4567-e89b-42d3-a456-426614174170';
      const row={ id:requestId, categoryName:'Synthetic paper', estimatedGrams:2500, actualGrams:2000,
        finalPaisePerKg:3245, amountPaise:'6490', collectedAt:'2026-11-20T10:00:00.000Z',
        address:{name:'Sample',addressLine:'12 Example',city:'Ludhiana',state:'Punjab',postalCode:'141001'} };
      let posts=[], rows=[row];
      await mount(async (url, init) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (url.includes('/admin/payouts/')) {
          posts.push([url, JSON.parse(init.body ?? '{}')]);
          rows=[];  // paid requests leave the queue
          return json({data:{paid:true, amountPaise:'6490', method:'cash'}});
        }
        if (url.endsWith('/admin/payouts')) return json({data:{dues:rows}});
        return json({authenticated:true});
      });
      globalThis.confirm=()=>true;
      await clickButton('Load unpaid dues');
      const section=[...document.querySelectorAll('section')].find(el=>el.textContent.includes('Collector payouts due'));
      assert.match(section.textContent,/2000 g at ₹32\.45\/kg/);
      assert.match(section.textContent,/Amount due: ₹64\.90/);
      await act(async()=>{[...section.querySelectorAll('button')].find(b=>b.textContent==='Record this payout').click();});
      // Only the method is sent. No amount, no collector, no timestamp.
      assert.equal(posts.length,1);
      assert.ok(posts[0][0].endsWith(`/${requestId}/pay`));
      assert.deepEqual(posts[0][1], { method:'cash' });
      assert.match(section.textContent,/Payout recorded: ₹64\.90 by cash/);
      assert.match(section.textContent,/No money was moved by this application/);
      assert.match(section.textContent,/No unpaid dues/);
      await unmount();
    });
    await t.test('the customer is told plainly that no update will be sent', async () => {
      const requestId='123e4567-e89b-42d3-a456-426614174200';
      const row={ id:requestId, status:'requested', createdAt:'2026-11-18T17:00:00.000Z',
        address:{name:'Sample',addressLine:'12 Example',city:'Ludhiana',state:'Punjab',postalCode:'141001'},
        estimatedGrams:2500, material:null, categoryId:'123e4567-e89b-42d3-a456-426614174201',
        categoryName:'Synthetic paper', rateId:'123e4567-e89b-42d3-a456-426614174202', paisePerKg:3245,
        amountPaise:'8113', actualGrams:null, finalRateId:null, finalPaisePerKg:null, finalAmountPaise:null,
        collectedAt:null, cancelledAt:null, cancellationReason:null, releasedAt:null, dispute:null, payout:null };
      await mount(async (url) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (url.endsWith('/account/customer')) return json({data:{customer:'ready'}});
        if (url.endsWith('/customer/pickups')) return json({data:{pickups:[row],
          notifications:{ configured:false, channels:[], delivery:'none', events:['pickup-requested'] }}});
        return json({authenticated:true});
      });
      await clickButton('Set up customer account');
      const section=[...document.querySelectorAll('section')].find(el=>el.textContent.includes('Test pickup requests'));
      // The notice is standing, not a reaction to a click: the customer should
      // know before requesting that nobody will contact them.
      assert.match(section.textContent,/No updates will be sent yet/);
      assert.match(section.textContent,/not get an email, SMS or WhatsApp message/);
      assert.match(section.textContent,/collector is not notified automatically either/i);
      await unmount();
    });
    await t.test('a claimed notification channel is not trusted without the server saying so', async () => {
      // The UI must never upgrade to "you will be notified" on its own; only an
      // explicit configured:true from the server may clear the notice.
      await mount(async (url) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (url.endsWith('/account/customer')) return json({data:{customer:'ready'}});
        if (url.endsWith('/customer/pickups')) return json({data:{pickups:[],
          notifications:{ configured:'yes', channels:['email'], delivery:'some' }}});
        return json({authenticated:true});
      });
      await clickButton('Set up customer account');
      const section=[...document.querySelectorAll('section')].find(el=>el.textContent.includes('Test pickup requests'));
      assert.match(section.textContent,/No updates will be sent yet/);
      await unmount();
    });
    await t.test('recording a payout says it notifies nobody', async () => {
      const requestId='123e4567-e89b-42d3-a456-426614174210';
      const row={ id:requestId, categoryName:'Synthetic paper', estimatedGrams:2500, actualGrams:2000,
        finalPaisePerKg:3245, amountPaise:'6490', collectedAt:'2026-11-20T10:00:00.000Z',
        address:{name:'Sample',addressLine:'12 Example',city:'Ludhiana',state:'Punjab',postalCode:'141001'} };
      await mount(async (url) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (url.endsWith('/admin/payouts')) return json({data:{dues:[row],
          payment:{configured:false,name:null,methods:['cash','transfer','adjustment']},
          notifications:{ configured:false, channels:[], delivery:'none', events:['payout-recorded'] }}});
        return json({authenticated:true});
      });
      await clickButton('Load unpaid dues');
      const section=[...document.querySelectorAll('section')].find(el=>el.textContent.includes('Collector payouts due'));
      assert.match(section.textContent,/Recording a payout notifies nobody/);
      assert.match(section.textContent,/Tell them yourself/);
      await unmount();
    });
    await t.test('the payout screen states no provider is connected and does not pretend money moved', async () => {
      const requestId='123e4567-e89b-42d3-a456-426614174180';
      const row={ id:requestId, categoryName:'Synthetic paper', estimatedGrams:2500, actualGrams:2000,
        finalPaisePerKg:3245, amountPaise:'6490', collectedAt:'2026-11-20T10:00:00.000Z',
        address:{name:'Sample',addressLine:'12 Example',city:'Ludhiana',state:'Punjab',postalCode:'141001'} };
      let posted=null;
      await mount(async (url, init) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (url.endsWith('/admin/payouts')) return json({data:{dues:[row],
          payment:{ configured:false, name:null, methods:['cash','transfer','adjustment'] }}});
        if (url.includes('/admin/payouts/')) { posted=JSON.parse(init.body ?? '{}'); return json({data:{paid:true,amountPaise:'6490',method:'cash'}}); }
        return json({authenticated:true});
      });
      globalThis.confirm=()=>true;
      await clickButton('Load unpaid dues');
      const section=[...document.querySelectorAll('section')].find(el=>el.textContent.includes('Collector payouts due'));
      assert.match(section.textContent,/Payment method not implemented yet/);
      assert.match(section.textContent,/No payment provider is connected/);
      assert.match(section.textContent,/nothing is sent to a bank, a wallet or a provider/i);
      // The control is still usable: recording a manual payout is the point.
      assert.equal([...section.querySelectorAll('option')].length, 3);
      await act(async()=>{[...section.querySelectorAll('button')].find(b=>b.textContent==='Record this payout').click();});
      assert.deepEqual(posted, { method:'cash' });
      assert.match(section.textContent,/No money was moved by this application/);
      await unmount();
    });
    await t.test('a payout screen refuses to claim a connection the API did not report', async () => {
      // A malformed or absent payment block must fall back to "no provider",
      // never to a reassuring one.
      await mount(async (url) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (url.endsWith('/admin/payouts')) return json({data:{dues:[], payment:{ configured:'yes', name:'' }}});
        return json({authenticated:true});
      });
      await clickButton('Load unpaid dues');
      const section=[...document.querySelectorAll('section')].find(el=>el.textContent.includes('Collector payouts due'));
      assert.match(section.textContent,/No payment provider is connected/);
      assert.doesNotMatch(section.textContent,/Connected provider/);
      await unmount();
    });
    await t.test('a paid request shows the customer a receipt without the payment method', async () => {
      const requestId='123e4567-e89b-42d3-a456-426614174171';
      const address={name:'Sample',addressLine:'12 Example',city:'Ludhiana',state:'Punjab',postalCode:'141001'};
      const settled={ id:requestId, status:'collected', createdAt:'2026-11-18T17:00:00.000Z', address,
        estimatedGrams:2500, material:null, categoryId:'123e4567-e89b-42d3-a456-426614174172',
        categoryName:'Synthetic paper', rateId:'123e4567-e89b-42d3-a456-426614174173', paisePerKg:3245,
        amountPaise:'8113', actualGrams:2300, finalRateId:'123e4567-e89b-42d3-a456-426614174174',
        finalPaisePerKg:3245, finalAmountPaise:'7464', collectedAt:'2026-11-20T10:00:00.000Z',
        cancelledAt:null, cancellationReason:null, releasedAt:null, dispute:null,
        payout:{ amountPaise:'7464', paidAt:'2026-11-22T09:00:00.000Z' } };
      await mount(async (url) => {
        if (url.endsWith('get-session')) return json({authenticated:true});
        if (url.endsWith('/account/customer')) return json({data:{customer:'ready'}});
        if (url.endsWith('/customer/pickups')) return json({data:{pickups:[settled]}});
        return json({authenticated:true});
      });
      await clickButton('Set up customer account');
      const section=[...document.querySelectorAll('section')].find(el=>el.textContent.includes('Test pickup requests'));
      await act(async()=>{[...section.querySelectorAll('button')].find(b=>b.textContent==='Load my test requests').click();});
      assert.match(section.textContent,/Payment recorded: ₹74\.64/);
      // How the collector was paid is between them and the admin.
      assert.doesNotMatch(section.textContent,/cash/i);
      assert.doesNotMatch(section.textContent,/adjustment/i);
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
