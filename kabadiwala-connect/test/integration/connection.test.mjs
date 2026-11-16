import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { test } from 'node:test';

async function freePort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return port;
}

function startNode(args, env, ready) {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out starting process: ${output}`)), 20000);
    const observe = (chunk) => {
      output += chunk.toString();
      if (ready.test(output)) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', observe);
    child.stderr.on('data', observe);
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Process exited (${code}): ${output}`)); });
  });
  return { child, started };
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

// Run after both builds; the web and real API processes are started just for this test.
test('web-origin liveness forwards safely and reports upstream failures', { timeout: 30000 }, async () => {
  const apiPort = await freePort();
  let webPort = await freePort();
  while (webPort === apiPort) webPort = await freePort();
  const api = startNode(['apps/api/dist/server.js'], { PORT: String(apiPort) }, /API listening on port/);
  let web;
  let mock;
  try {
    await api.started;
    web = startNode(['node_modules/next/dist/bin/next', 'start', 'apps/web', '-H', '127.0.0.1', '-p', String(webPort)],
      { API_INTERNAL_ORIGIN: `http://127.0.0.1:${apiPort}`, NEXT_TELEMETRY_DISABLED: '1' }, /Ready in/);
    await web.started;
    const origin = `http://127.0.0.1:${webPort}`;
    const home = await fetch(origin);
    const html = await home.text();
    assert.equal(home.status, 200);
    assert.match(html, /Under development/);
    assert.match(html, /href="\/api\/v1\/health\/live"/);
    const path = `${origin}/api/v1/health/live`;
    let response = await fetch(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { data: { status: 'alive', service: 'api' } });

    await stop(api.child);
    response = await fetch(path);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: { code: 'API_UNAVAILABLE', message: 'API liveness is unavailable.' } });

    // Upstream responses are validated, filtered, and redirects never followed.
    let mode = 'invalid';
    mock = createHttpServer((_request, reply) => {
      if (mode === 'redirect') {
        reply.writeHead(302, { location: 'http://127.0.0.1:1/' });
        reply.end();
        return;
      }
      reply.writeHead(200, { 'content-type': 'application/json' });
      reply.end(JSON.stringify({ data: { status: mode === 'valid' ? 'alive' : 'wrong', service: 'api' }, secret: 'internal-detail' }));
    });
    mock.listen(apiPort, '127.0.0.1');
    await once(mock, 'listening');
    response = await fetch(path);
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes('internal-detail'));
    mode = 'valid';
    response = await fetch(path);
    assert.deepEqual(await response.json(), { data: { status: 'alive', service: 'api' } });
    mode = 'redirect';
    response = await fetch(path);
    assert.equal(response.status, 503);
  } finally {
    if (mock?.listening) await new Promise((resolve, reject) => mock.close((err) => err ? reject(err) : resolve()));
    await stop(web?.child);
    await stop(api.child);
  }
});
