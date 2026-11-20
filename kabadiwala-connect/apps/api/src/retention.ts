import type pg from 'pg';

// RETENTION POLICY.
//
// What this module will not do is the important part. A payout row is a record
// that money moved, and the only place its amount can be reconstructed from is
// the request it belongs to. Deleting that request to satisfy a data-minimising
// policy would destroy the accounting trail, so this module never deletes a
// request and never deletes a payout.
//
// What it does instead is REDACTION: once a request has been closed for long
// enough that nobody needs to visit the address again, the personal fields are
// overwritten with a fixed marker and the address stops being recoverable, while
// the money, the weight, the rates and the timestamps stay exactly as recorded.
// The record keeps its accounting value and loses its personal value. That is
// the trade a retention policy is supposed to make.
//
// Notifications are different: a message has no accounting value once it has
// been read, so read notifications are genuinely deleted after their window.
// Unread ones are kept far longer, because an unread notification may be the
// only notice an account ever gets that a payout was recorded.
//
// Everything is opt-in and dry by default. There is no scheduler: an operator
// runs one command, sees exactly what would change, and only then passes the
// flag that writes.

// A closed request keeps its address for this long. Two years covers an ordinary
// dispute, the time a customer realistically takes to notice a wrong weight, and
// the window in which a grievance about the service can still be raised.
export const ADDRESS_RETENTION_DAYS = 730;

// Read notifications are deleted after this long: they have been delivered, and
// delivery was the whole point of the row.
export const READ_NOTIFICATION_RETENTION_DAYS = 180;

// Unread notifications survive longer, because "nobody looked at it yet" is not
// the same as "nobody needs it".
export const UNREAD_NOTIFICATION_RETENTION_DAYS = 730;

// The marker written over a redacted field. Deliberately not an empty string:
// an empty address is indistinguishable from a bug, a form that failed to save,
// or a row that was never filled in. This text says what happened.
export const REDACTED = '[removed by retention policy]';

// The classification is exported so a test can assert the whole policy rather
// than trusting the sweep to remember it. `permanent` means no code path in
// this module can remove the row.
export const RETENTION_RULES = {
  // Money moved. The ledger row and the request it settles are both permanent.
  payouts: 'permanent',
  requests: 'permanent, address redacted after the window',
  // Never removed, whatever their age: a live request is somebody's pending
  // business, and deleting one would silently cancel it.
  liveRequests: 'permanent',
  readNotifications: 'deleted after the window',
  unreadNotifications: 'deleted only after a much longer window',
} as const;

export type RetentionAction =
  | { kind: 'redact-address'; requestId: string; reason: string }
  | { kind: 'delete-read-notification'; notificationId: string; reason: string }
  | { kind: 'delete-unread-notification'; notificationId: string; reason: string };

export type RetentionCounts = {
  'redact-address': number;
  'delete-read-notification': number;
  'delete-unread-notification': number;
};

export type RetentionPlan = {
  actions: RetentionAction[];
  counts: RetentionCounts;
  // True when the per-call cap was reached; run again for the rest.
  truncated: boolean;
  policy: {
    addressDays: number;
    readNotificationDays: number;
    unreadNotificationDays: number;
  };
};

export type RetentionReport = RetentionPlan & { applied: RetentionCounts };

const DEFAULT_LIMIT = 500;
// A sweep is bounded per call. An unbounded UPDATE over years of rows holds
// locks for an unknown time, and on a development database is indistinguishable
// from an accident.
const MAX_LIMIT = 5000;

function normaliseLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw Error('Invalid limit');
  return limit;
}

const zeroCounts = (): RetentionCounts =>
  ({ 'redact-address': 0, 'delete-read-notification': 0, 'delete-unread-notification': 0 });

// A request is redactable when it is closed, settled, undisputed, and old.
//
// `requested` and `accepted` are excluded no matter their age: an abandoned
// request is somebody's pending business and a support conversation waiting to
// happen. A request with an open dispute is excluded because the dispute is
// ongoing and the address may still be needed to resolve it.
//
// Age is measured from when it closed, never from creation: an old account with
// a pickup collected yesterday must keep that address.
const REDACTABLE_SQL = `
  SELECT r.id::text AS id
  FROM kabadi_pickup.requests r
  WHERE r.status IN ('collected','cancelled')
    AND (r.dispute_status IS NULL OR r.dispute_status IN ('resolved','rejected'))
    AND r.address_redacted_at IS NULL
    AND COALESCE(r.collected_at, r.cancelled_at) < now() - make_interval(days => $1)
  ORDER BY COALESCE(r.collected_at, r.cancelled_at), r.id
  LIMIT $2`;

// A request whose payout was recorded is still redactable: the payout names the
// request id, the amount and the collector, none of which are personal data.
// What is erased is only the address, which the ledger never needs.
const READ_NOTIFICATION_SQL = `
  SELECT n.id::text AS id
  FROM kabadi_pickup.notifications n
  WHERE n.read_at IS NOT NULL AND n.created_at < now() - make_interval(days => $1)
  ORDER BY n.created_at, n.id
  LIMIT $2`;

// A notification whose subject is a redacted request is not touched here: its
// text never contained the address, only a weight and an amount.
const UNREAD_NOTIFICATION_SQL = `
  SELECT n.id::text AS id
  FROM kabadi_pickup.notifications n
  WHERE n.read_at IS NULL AND n.created_at < now() - make_interval(days => $1)
  ORDER BY n.created_at, n.id
  LIMIT $2`;

export function createRetentionStore(pool: pg.Pool) {
  async function collect(c: pg.PoolClient, limit: number): Promise<RetentionPlan> {
    const addresses = await c.query<{ id: string }>(REDACTABLE_SQL, [ADDRESS_RETENTION_DAYS, limit + 1]);
    const readNotices = await c.query<{ id: string }>(READ_NOTIFICATION_SQL, [READ_NOTIFICATION_RETENTION_DAYS, limit + 1]);
    const unreadNotices = await c.query<{ id: string }>(UNREAD_NOTIFICATION_SQL, [UNREAD_NOTIFICATION_RETENTION_DAYS, limit + 1]);

    const actions: RetentionAction[] = [
      ...addresses.rows.slice(0, limit).map(r => ({
        kind: 'redact-address' as const, requestId: r.id,
        reason: `closed more than ${ADDRESS_RETENTION_DAYS} days ago; address removed, amounts kept`,
      })),
      ...readNotices.rows.slice(0, limit).map(n => ({
        kind: 'delete-read-notification' as const, notificationId: n.id,
        reason: `read and older than ${READ_NOTIFICATION_RETENTION_DAYS} days`,
      })),
      ...unreadNotices.rows.slice(0, limit).map(n => ({
        kind: 'delete-unread-notification' as const, notificationId: n.id,
        reason: `never read and older than ${UNREAD_NOTIFICATION_RETENTION_DAYS} days`,
      })),
    ];

    const counts = zeroCounts();
    for (const action of actions) counts[action.kind]++;
    return {
      actions,
      counts,
      truncated: addresses.rows.length > limit || readNotices.rows.length > limit || unreadNotices.rows.length > limit,
      policy: {
        addressDays: ADDRESS_RETENTION_DAYS,
        readNotificationDays: READ_NOTIFICATION_RETENTION_DAYS,
        unreadNotificationDays: UNREAD_NOTIFICATION_RETENTION_DAYS,
      },
    };
  }

  return {
    // Read-only. Running this is always safe and is the intended first step.
    async plan(limit?: number): Promise<RetentionPlan> {
      const capped = normaliseLimit(limit);
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET TRANSACTION READ ONLY');
        const result = await collect(c, capped);
        await c.query('COMMIT');
        return result;
      } catch (error) { try { await c.query('ROLLBACK'); } catch {} throw error; } finally { c.release(); }
    },

    // One transaction: either every action in the plan lands or none does. A
    // half-applied sweep is the state that is hard to reason about afterwards.
    async apply(limit?: number): Promise<RetentionReport> {
      const capped = normaliseLimit(limit);
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        // Serialise sweeps so two operators cannot act on overlapping sets and
        // report different totals.
        await c.query('SELECT pg_advisory_xact_lock($1, $2)', [1262572353, 4]);
        const result = await collect(c, capped);
        const applied = zeroCounts();

        const requestIds = result.actions.flatMap(a => a.kind === 'redact-address' ? [a.requestId] : []);
        if (requestIds.length) {
          // The conditions are repeated in the UPDATE. Between planning and
          // applying, a dispute can be raised or a collection can happen; the
          // window between the two statements must not let this erase an address
          // that is suddenly current again.
          const rows = await c.query<{ id: string }>(
            `UPDATE kabadi_pickup.requests r
             SET name = $2, address_line = $2, city = $2, state = $2, postal_code = $2,
                 address_redacted_at = now()
             WHERE r.id = ANY($1::uuid[])
               AND r.status IN ('collected','cancelled')
               AND (r.dispute_status IS NULL OR r.dispute_status IN ('resolved','rejected'))
               AND r.address_redacted_at IS NULL
               AND COALESCE(r.collected_at, r.cancelled_at) < now() - make_interval(days => $3)
             RETURNING r.id::text AS id`, [requestIds, REDACTED, ADDRESS_RETENTION_DAYS]);
          applied['redact-address'] = rows.rows.length;
        }

        const readIds = result.actions.flatMap(a => a.kind === 'delete-read-notification' ? [a.notificationId] : []);
        if (readIds.length) {
          const rows = await c.query<{ id: string }>(
            `DELETE FROM kabadi_pickup.notifications
             WHERE id = ANY($1::uuid[]) AND read_at IS NOT NULL
               AND created_at < now() - make_interval(days => $2)
             RETURNING id::text AS id`, [readIds, READ_NOTIFICATION_RETENTION_DAYS]);
          applied['delete-read-notification'] = rows.rows.length;
        }

        const unreadIds = result.actions.flatMap(a => a.kind === 'delete-unread-notification' ? [a.notificationId] : []);
        if (unreadIds.length) {
          const rows = await c.query<{ id: string }>(
            `DELETE FROM kabadi_pickup.notifications
             WHERE id = ANY($1::uuid[]) AND read_at IS NULL
               AND created_at < now() - make_interval(days => $2)
             RETURNING id::text AS id`, [unreadIds, UNREAD_NOTIFICATION_RETENTION_DAYS]);
          applied['delete-unread-notification'] = rows.rows.length;
        }

        await c.query('COMMIT');
        return { ...result, applied };
      } catch (error) { try { await c.query('ROLLBACK'); } catch {} throw error; } finally { c.release(); }
    },
  };
}
