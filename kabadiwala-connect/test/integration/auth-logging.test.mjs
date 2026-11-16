// Exercises Next's development request logger with synthetic callback data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

async function port() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const result = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return result;
}

test('development request logs omit auth callback URLs', { timeout: 90000 }, async () => {
  const webPort = await port();
  const unavailablePort = await port();
  const marker = `synthetic-${randomBytes(16).toString('hex')}`;
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', 'apps/web', '-H', '127.0.0.1', '-p', String(webPort)], {
    env: { ...process.env, AUTH_PUBLIC_ORIGIN: `http://127.0.0.1:${webPort}`, API_INTERNAL_ORIGIN: `http://127.0.0.1:${unavailablePort}`, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  const onData = data => { logs += data.toString(); };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Web startup timed out')), 30000);
      const ready = data => { if (String(data).includes('Ready in')) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', ready); child.stderr.on('data', ready);
      child.once('error', reject);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Web startup failed: ${code}`)); });
    });
    const origin = `http://127.0.0.1:${webPort}`;
    // No upstream, so this cannot contact Google or create a session.
    assert.equal((await fetch(`${origin}/api/auth/callback/google?code=${marker}&state=${marker}`)).status, 503);
    assert.equal((await fetch(origin)).status, 200);
    await new Promise((resolve, reject) => {
      if (/GET \/ 200/.test(logs)) return resolve();
      const timer = setTimeout(() => reject(new Error('Expected normal request log was not observed')), 10000);
      const check = () => { if (/GET \/ 200/.test(logs)) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', check); child.stderr.on('data', check);
    });
    assert.ok(!logs.includes(marker), 'callback query must not appear in Next development request logs');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
  }
});
