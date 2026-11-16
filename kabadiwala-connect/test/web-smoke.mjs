import assert from 'node:assert/strict';
import { test } from 'node:test';

// Run separately from the unit tests against a locally running web server.
const baseUrl = process.env.WEB_BASE_URL ?? 'http://127.0.0.1:3000';

test('web foundation serves an honest placeholder', async () => {
  const response = await fetch(new URL('/', baseUrl), { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const text of ['Kabadiwala Connect', 'Under development', 'Collection requests and accounts']) {
    assert.ok(html.includes(text), `Missing expected text: ${text}`);
  }
});
