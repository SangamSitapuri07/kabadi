import test from 'node:test';
import assert from 'node:assert/strict';

// Retention is the one operation in this project that destroys data, so these
// tests are written around the negative claims: what must never be touched.
const { createRetentionStore, REDACTED, ADDRESS_RETENTION_DAYS, READ_NOTIFICATION_RETENTION_DAYS,
  UNREAD_NOTIFICATION_RETENTION_DAYS, RETENTION_RULES } = await import('../../apps/api/dist/retention.js');

// A pool that records every statement and answers by shape.
function fakePool(overrides = {}) {
  const statements = [];
  const pool = {
    statements,
    connect: async () => ({
      query: async (sql, params) => {
        const text = String(sql).replace(/\s+/g, ' ').trim();
        statements.push({ text, params });
        if (overrides[text.split(' ')[0]] !== undefined && !/^(SELECT|UPDATE|DELETE|INSERT|BEGIN|COMMIT|ROLLBACK|SET)$/.test(text)) return overrides[text.split(' ')[0]];
        if (text.startsWith('SELECT r.id::text AS id') && text.includes('address_redacted_at IS NULL')) {
          return { rows: (overrides.redactable ?? []).map(id => ({ id })) };
        }
        // `read_at IS NOT NULL` also contains "read_at IS NULL" as a substring,
        // so the read case has to be tested first and the unread case tested
        // against the negated predicate.
        if (text.startsWith('SELECT n.id::text AS id')) {
          const readOnly = text.includes('n.read_at IS NOT NULL');
          if (readOnly) return { rows: (overrides.readNotices ?? []).map(id => ({ id })) };
          return { rows: (overrides.unreadNotices ?? []).map(id => ({ id })) };
        }
        if (text.startsWith('UPDATE kabadi_pickup.requests')) {
          return { rows: (overrides.redacted ?? []).map(id => ({ id })) };
        }
        if (text.startsWith('DELETE FROM kabadi_pickup.notifications')) {
          // One delete per kind: report what that kind actually held.
          const readDelete = text.includes('read_at IS NOT NULL');
          const source = readDelete ? (overrides.readNotices ?? []) : (overrides.unreadNotices ?? []);
          const wanted = readDelete ? (overrides.deletedRead ?? null) : (overrides.deletedUnread ?? null);
          const ids = wanted ?? source;
          return { rows: ids.map(id => ({ id })) };
        }
        return { rows: [] };
      },
      release: () => {},
    }),
  };
  return pool;
}

test('the policy keeps every financial row and only ever removes an address', () => {
  // These assertions are the policy. If somebody later makes a payout or a
  // request deletable, this test is the thing that should stop them.
  assert.equal(RETENTION_RULES.payouts, 'permanent');
  assert.equal(RETENTION_RULES.liveRequests, 'permanent');
  assert.match(RETENTION_RULES.requests, /permanent, address redacted/);
  // Windows are ordered the way the risk is: the notice nobody read outlives
  // the one somebody already consumed.
  assert.ok(UNREAD_NOTIFICATION_RETENTION_DAYS > READ_NOTIFICATION_RETENTION_DAYS);
  assert.ok(ADDRESS_RETENTION_DAYS > READ_NOTIFICATION_RETENTION_DAYS);
});

test('the plan names only closed, settled, undisputed, old requests', async () => {
  const pool = fakePool({ redactable: ['r1', 'r2'] });
  const plan = await createRetentionStore(pool).plan();
  assert.equal(plan.counts['redact-address'], 2);
  const sql = pool.statements.map(s => s.text).join('\n');
  // A live request is somebody's pending business: never redacted.
  assert.match(sql, /status IN \('collected','cancelled'\)/);
  // An open dispute may still need the address.
  assert.match(sql, /dispute_status IS NULL OR r\.dispute_status IN \('resolved','rejected'\)/);
  // Aged from when it closed, not from when it was created.
  assert.match(sql, /COALESCE\(r\.collected_at, r\.cancelled_at\) < now\(\) - make_interval/);
  // Already-redacted rows are not re-planned.
  assert.match(sql, /address_redacted_at IS NULL/);
  // Nothing in a plan may delete a request or a payout.
  assert.doesNotMatch(sql, /DELETE FROM kabadi_pickup\.(requests|payouts)/i);
});

test('a dry run changes nothing and never opens a writable transaction', async () => {
  const pool = fakePool({ redactable: ['r1'], readNotices: ['n1'] });
  const plan = await createRetentionStore(pool).plan();
  assert.equal(plan.counts['redact-address'], 1);
  assert.equal(plan.counts['delete-read-notification'], 1);
  const statements = pool.statements.map(s => s.text);
  assert.ok(statements.some(s => s === 'SET TRANSACTION READ ONLY'));
  // The only writes allowed in a dry run are transaction control.
  const writes = statements.filter(s => /^(UPDATE|DELETE|INSERT|ALTER|DROP)/.test(s));
  assert.deepEqual(writes, []);
});

test('applying redacts the address but leaves every amount and timestamp alone', async () => {
  const pool = fakePool({ redactable: ['r1'], redacted: ['r1'] });
  const report = await createRetentionStore(pool).apply();
  assert.equal(report.applied['redact-address'], 1);
  const statement = pool.statements.find(s => s.text.startsWith('UPDATE kabadi_pickup.requests'));
  assert.ok(statement, 'an update was issued');
  // Only the five personal columns move, plus the marker.
  assert.match(statement.text, /SET name = \$2, address_line = \$2, city = \$2, state = \$2, postal_code = \$2, address_redacted_at = now\(\)/);
  assert.equal(statement.params[1], REDACTED);
  // The amount, weight, rate and timestamps are not in the SET clause at all.
  for (const column of ['final_amount_paise', 'actual_grams', 'final_paise_per_kg', 'collected_at', 'user_id', 'collector_id']) {
    assert.ok(!statement.text.includes(`SET ${column}`), `${column} must not be overwritten`);
  }
});

test('the apply step re-checks its own conditions instead of trusting the plan', async () => {
  // This is the race that matters: a plan is read, then a dispute is raised or a
  // row changes before the write. The UPDATE must not act on the stale decision.
  const pool = fakePool({ redactable: ['r1'], redacted: [] });
  const report = await createRetentionStore(pool).apply();
  assert.equal(report.applied['redact-address'], 0);
  // The planned count is still reported, so the CLI can show the difference as a
  // skipped row rather than silently doing less than it said.
  assert.equal(report.counts['redact-address'], 1);
  const statement = pool.statements.find(s => s.text.startsWith('UPDATE kabadi_pickup.requests'));
  assert.match(statement.text, /status IN \('collected','cancelled'\)/);
  assert.match(statement.text, /NOT EXISTS|dispute_status IS NULL OR r\.dispute_status IN/);
  assert.match(statement.text, /address_redacted_at IS NULL/);
  assert.match(statement.text, /COALESCE\(r\.collected_at, r\.cancelled_at\) < now\(\) - make_interval/);
});

test('read and unread notifications are deleted under separate, ordered windows', async () => {
  const pool = fakePool({ readNotices: ['n1'], unreadNotices: ['n2'], deletedRead: ['n1'], deletedUnread: ['n2'] });
  const report = await createRetentionStore(pool).apply();
  assert.equal(report.applied['delete-read-notification'], 1);
  assert.equal(report.applied['delete-unread-notification'], 1);
  const deletes = pool.statements.filter(s => s.text.startsWith('DELETE FROM'));
  assert.equal(deletes.length, 2);
  const byWindow = deletes.map(s => ({ read: s.text.includes('read_at IS NOT NULL'), days: s.params[1] }));
  assert.ok(byWindow.some(d => d.read && d.days === READ_NOTIFICATION_RETENTION_DAYS));
  assert.ok(byWindow.some(d => !d.read && d.days === UNREAD_NOTIFICATION_RETENTION_DAYS));
  // A delete re-asserts its own condition; an id alone is not enough.
  for (const statement of deletes) {
    assert.match(statement.text, /created_at < now\(\) - make_interval/);
  }
});

test('one transaction wraps the whole sweep, and a failure rolls all of it back', async () => {
  const pool = fakePool({ redactable: ['r1'], readNotices: ['n1'], redacted: ['r1'], deletedRead: ['n1'] });
  const store = createRetentionStore(pool);
  await store.apply();
  const statements = pool.statements.map(s => s.text);
  assert.equal(statements[0], 'BEGIN');
  assert.equal(statements.at(-1), 'COMMIT');
  // Two sweeps cannot race each other into different totals.
  assert.ok(statements.some(s => s.startsWith('SELECT pg_advisory_xact_lock')));

  const failing = fakePool({ redactable: ['r1'] });
  const originalConnect = failing.connect;
  failing.connect = async () => {
    const client = await originalConnect();
    let calls = 0;
    return { ...client, query: async (sql, params) => {
      // Fail after the plan and the update, so the rollback has work to undo.
      if (String(sql).startsWith('UPDATE kabadi_pickup.requests')) throw new Error('synthetic failure');
      return client.query(sql, params);
    } };
  };
  await assert.rejects(() => createRetentionStore(failing).apply(), /synthetic failure/);
  assert.ok(failing.statements.map(s => s.text).includes('ROLLBACK'));
});

test('a limit is validated and bounded rather than trusted', async () => {
  const store = createRetentionStore(fakePool());
  await assert.rejects(() => store.plan(0), /Invalid limit/);
  await assert.rejects(() => store.plan(1.5), /Invalid limit/);
  await assert.rejects(() => store.plan(99_999), /Invalid limit/);
  await assert.rejects(() => store.apply('10'), /Invalid limit/);
  // The cap applied to the query is the requested limit plus one, so the store
  // can tell "exactly full" from "there is more".
  const pool = fakePool({ redactable: ['r1', 'r2', 'r3'] });
  const plan = await createRetentionStore(pool).plan(2);
  assert.equal(plan.counts['redact-address'], 2);
  assert.equal(plan.truncated, true);
  const select = pool.statements.find(s => s.text.includes('address_redacted_at IS NULL'));
  assert.equal(select.params[1], 3);
});

test('a redacted request reports no address and says why, never the marker text', async () => {
  const { toPickup } = await import('../../apps/api/dist/pickups.js');
  const base = {
    id: '11111111-1111-4111-8111-111111111111', status: 'collected',
    created_at: new Date('2024-01-01T00:00:00Z'), name: 'Asha', address_line: '12 Main St',
    city: 'Ludhiana', state: 'Punjab', postal_code: '141001',
    estimated_grams: 2000, material: null,
    category_id: '22222222-2222-4222-8222-222222222222', category_name: 'Paper',
    rate_id: '33333333-3333-4333-8333-333333333333', paise_per_kg: 3245, amount_paise: '6490',
    actual_grams: 2000, final_rate_id: '33333333-3333-4333-8333-333333333333',
    final_paise_per_kg: 3245, final_amount_paise: '6490', collected_at: new Date('2024-01-01T00:00:00Z'),
    cancelled_at: null, cancellation_reason: null, released_at: null,
    dispute_status: null, dispute_reason: null, dispute_raised_at: null, dispute_resolved_at: null,
    payout_amount_paise: null, payout_method: null, payout_paid_at: null,
  };

  const live = toPickup({ ...base, address_redacted_at: null });
  assert.equal(live.address.city, 'Ludhiana');
  assert.equal(live.addressRedactedAt, null);

  // After redaction the columns literally hold the marker text. It must not be
  // forwarded as though it were an address.
  const erased = toPickup({ ...base, name: REDACTED, address_line: REDACTED, city: REDACTED,
    state: REDACTED, postal_code: REDACTED, address_redacted_at: new Date('2026-11-14T00:00:00Z') });
  assert.equal(erased.address, null);
  assert.equal(erased.addressRedactedAt, '2026-11-14T00:00:00.000Z');
  // The accounting facts are untouched. This is the whole point: the money
  // survives the redaction.
  assert.equal(erased.finalAmountPaise, '6490');
  assert.equal(erased.actualGrams, 2000);
  assert.equal(erased.finalPaisePerKg, 3245);
  assert.equal(erased.collectedAt, '2024-01-01T00:00:00.000Z');
  assert.ok(!JSON.stringify(erased).includes(REDACTED), 'the marker is never sent to a client');
});
