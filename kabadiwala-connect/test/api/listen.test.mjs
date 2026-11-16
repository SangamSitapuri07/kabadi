import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../../apps/api/dist/app.js';
import { listenLocally } from '../../apps/api/dist/listen.js';

test('development API binds IPv4 loopback and serves local requests', async () => {
  const server = listenLocally(createApp(), 0);
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.equal(address.address, '127.0.0.1');
    assert.equal(address.family, 'IPv4');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/health/live`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { status: 'alive', service: 'api' } });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
