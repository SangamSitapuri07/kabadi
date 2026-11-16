import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import express from 'express';
import { createApp, errorHandler } from '../../apps/api/dist/app.js';

let server;
let baseUrl;
before(async () => {
  const app = createApp();
  server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

test('liveness returns only process status and no framework header', async () => {
  const response = await fetch(`${baseUrl}/api/v1/health/live`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { data: { status: 'alive', service: 'api' } });
});

test('unknown routes do not imply marketplace or database readiness', async () => {
  for (const path of ['/api/v1/health/ready', '/api/v1/requests', '/missing']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  }
});

test('malformed JSON gets a sanitized 400', async () => {
  const response = await fetch(`${baseUrl}/api/v1/requests`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"secret":',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { code: 'INVALID_JSON', message: 'Malformed JSON body.' } });
});

test('oversized JSON gets a sanitized 413', async () => {
  const response = await fetch(`${baseUrl}/api/v1/requests`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x'.repeat(33000) }),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' } });
});

test('unexpected error messages are not sent to clients', async () => {
  const app = express();
  app.get('/test', () => { throw new Error('sensitive internal details'); });
  app.use(errorHandler);
  const temporary = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  try {
    const response = await fetch(`http://127.0.0.1:${temporary.address().port}/test`);
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.ok(!body.includes('sensitive internal details'));
    assert.deepEqual(JSON.parse(body), { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
  } finally {
    await new Promise((resolve, reject) => temporary.close((err) => err ? reject(err) : resolve()));
  }
});
