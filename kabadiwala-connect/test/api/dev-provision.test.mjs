import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevProvisioner } from '../../apps/api/dist/dev-provision.js';

function provisionPool({ userExists = true, accountFresh = true } = {}) {
  const statements = [];
  return { statements, connect: async () => ({
    query: async (sql, params) => {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      statements.push({ text, params });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.startsWith('SELECT 1 FROM "user"')) return { rowCount: userExists ? 1 : 0, rows: [] };
      // The check is an explicit SELECT, so the fake answers that, not a row count.
      if (text === 'SELECT 1 FROM kabadi_authz.accounts WHERE user_id=$1') {
        return { rowCount: accountFresh ? 0 : 1, rows: accountFresh ? [] : [{}] };
      }
      if (text.startsWith('INSERT INTO kabadi_authz.accounts')) return { rowCount: 1, rows: [] };
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  }) };
}

test('provisioning writes the account and its chosen role in one transaction', async () => {
  const pool = provisionPool();
  assert.equal(await createDevProvisioner(pool)('user-1', 'shop'), 'ready');
  const texts = pool.statements.map(s => s.text);
  assert.equal(texts[0], 'BEGIN');
  assert.equal(texts.at(-1), 'COMMIT');
  // The existence check comes before any write, so a taken id is refused without
  // writing anything at all.
  assert.ok(texts.some(t => t === 'SELECT 1 FROM kabadi_authz.accounts WHERE user_id=$1'));
  // The account row first, then the grant: a grant cannot reference an account
  // that does not exist.
  const account = texts.findIndex(t => t.startsWith('INSERT INTO kabadi_authz.accounts'));
  const grant = texts.findIndex(t => t.startsWith('INSERT INTO kabadi_authz.role_grants'));
  assert.ok(account !== -1 && grant !== -1 && account < grant);
  // The role comes from the caller's selection, not from the email.
  assert.deepEqual(pool.statements[grant].params, ['user-1', 'shop']);
});

test('an id that already has an account is refused, so the form cannot add a tier to it', async () => {
  const pool = provisionPool({ accountFresh: false });
  assert.equal(await createDevProvisioner(pool)('user-1', 'mandi'), 'taken');
  // A taken id must not leave a half-written grant behind.
  assert.equal(pool.statements.some(s => s.text.startsWith('INSERT INTO kabadi_authz.role_grants')), false);
});

test('an auth user that does not exist is refused rather than invented', async () => {
  const pool = provisionPool({ userExists: false });
  assert.equal(await createDevProvisioner(pool)('nobody', 'shop'), 'forbidden');
  assert.equal(pool.statements.some(s => s.text.startsWith('INSERT INTO kabadi_authz.accounts')), false);
});

test('a failed write rolls back rather than leaving an account with no role', async () => {
  const statements = [];
  const pool = { connect: async () => ({
    query: async sql => {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      statements.push(text);
      if (text === 'BEGIN' || text === 'ROLLBACK' || text === 'COMMIT') return { rows: [] };
      if (text.startsWith('SELECT 1 FROM "user"')) return { rowCount: 1, rows: [] };
      if (text.startsWith('INSERT INTO kabadi_authz.accounts')) return { rowCount: 1, rows: [] };
      throw new Error('grant failed');
    },
    release: () => {},
  }) };
  await assert.rejects(() => createDevProvisioner(pool)('user-1', 'shop'));
  assert.ok(statements.includes('ROLLBACK'), 'rolled back');
  assert.equal(statements.includes('COMMIT'), false, 'never committed');
});
