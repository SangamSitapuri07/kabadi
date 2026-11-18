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
