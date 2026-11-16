// Component interaction tests in a DOM simulator; no Google or real users.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

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
const { GoogleSignIn } = createRequire(modulePath)(modulePath);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

test('Google sign-in component: session, errors, retry and sign-out', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:3000/' });
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let root;
  const mount = async (mockFetch) => {
    globalThis.fetch = mockFetch;
    root = createRoot(document.getElementById('root'));
    await act(async () => { root.render(React.createElement(GoogleSignIn)); });
  };
  const unmount = async () => { await act(async () => root.unmount()); root = undefined; };
  const click = async () => { await act(async () => { document.querySelector('button').click(); }); };
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
