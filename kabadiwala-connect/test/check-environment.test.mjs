import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkEnvironment, supportsNode } from '../scripts/check-environment.mjs';

test('accepts supported Node versions', () => {
  assert.equal(supportsNode('22.0.0'), true);
  assert.equal(supportsNode('24.1.2'), true);
});

test('rejects old or malformed versions', () => {
  for (const version of ['21.9.0', 'v22.0.0', '22', 'not-a-version']) {
    assert.equal(supportsNode(version), false);
  }
});

test('returns an actionable failure and success', () => {
  assert.deepEqual(checkEnvironment('20.0.0'), {
    ok: false,
    message: 'Node.js 22 or newer is required; found 20.0.0.',
  });
  assert.equal(checkEnvironment('22.22.3').ok, true);
});
