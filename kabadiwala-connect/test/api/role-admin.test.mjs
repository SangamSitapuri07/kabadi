import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeEmail, normalizeReason, normalizeRole, REASONS_MAX, REASONS_MIN } from '../../apps/api/dist/role-admin.js';

test('role tool normalizes only unambiguous emails and roles', () => {
  assert.equal(normalizeEmail('  Person@Example.COM '), 'person@example.com');
  for (const bad of [undefined, null, '', 'no-at.example', 'a@b', 'two@@example.com', 'space in@example.com', 'nul\u0000@example.com', 'x'.repeat(250) + '@example.com', 42, {}]) {
    assert.equal(normalizeEmail(bad), null, `expected rejection: ${String(bad).slice(0, 20)}`);
  }
  assert.equal(normalizeRole('admin'), 'admin');
  assert.equal(normalizeRole(' customer '), null, 'roles must not be trimmed or guessed');
  for (const bad of ['root', 'Admin', 'ADMIN', '', undefined, null, 7, ['admin']]) assert.equal(normalizeRole(bad), null);
});

test('role tool requires a bounded reason so changes are explainable', () => {
  assert.equal(normalizeReason('  bootstrap first admin for local testing  '), 'bootstrap first admin for local testing');
  for (const bad of [undefined, null, 12, '', 'short', 'a'.repeat(REASONS_MAX + 1), 'control\u0001characters here', '\uD800 lone surrogate reason']) {
    assert.equal(normalizeReason(bad), null, `expected rejection: ${String(bad).slice(0, 30)}`);
  }
  assert.equal(normalizeReason('a'.repeat(REASONS_MIN)), 'a'.repeat(REASONS_MIN));
  // Reasons are counted in code points, not UTF-16 units.
  assert.equal(normalizeReason('म'.repeat(REASONS_MIN)), 'म'.repeat(REASONS_MIN));
});

test('role tool explains which argument is wrong instead of one generic message', async () => {
  const { spawnSync } = await import('node:child_process');
  const run = (...args) => spawnSync(process.execPath, ['apps/api/dist/role-admin-cli.js', ...args], {
    encoding: 'utf8', env: { ...process.env, DEV_ROLE_TOOL_CONFIRM: 'yes', NODE_ENV: 'development' }, timeout: 20000,
  });
  // The auto-linked form that real terminals produce was the actual failure.
  const linked = run('grant', '[someone@example.test](mailto:someone@example.test)', 'admin', 'a long enough reason here');
  assert.equal(linked.status, 1);
  assert.match(linked.stderr, /bracketed or "mailto:" link formatting/);
  assert.doesNotMatch(linked.stderr, /schemas/, 'a bad argument must not blame the schema');
  const bare = run('grant', 'someone@example.test', 'root', 'a long enough reason here');
  assert.match(bare.stderr, /Invalid role "root"/);
  const short = run('grant', 'someone@example.test', 'admin', 'short');
  assert.match(short.stderr, /reason is too short \(5 characters; at least 10 are required\)/);
  const missing = run('grant', 'someone@example.test');
  assert.match(missing.stderr, /exactly three arguments/);
});
