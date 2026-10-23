import type * as SQLiteTypes from "expo-sqlite";

export type SyncStatus =
  | "PENDING"
  | "SYNCING"
  | "SYNCED"
  | "IDEMPOTENT_SKIPPED"
  | "CONFLICT_REVIEW";

export type SupportedOfflineOpType =
  | "DRAFT_LISTING_CREATE"
  | "KHATA_ADVANCE_RECORD"
  | "DISMANTLING_LOG";

export interface QueuedSyncOperation {
  idempotencyKey: string;
  clientEntityId: string;
  operationType: SupportedOfflineOpType;
  createdAtIso: string;
  payload: Record<string, unknown>;
  syncStatus: SyncStatus;
  retryCount: number;
  serverSummary?: Record<string, unknown>;
}

export interface PersistentQueueDriver {
  readonly driverName: "expo-sqlite" | "sqlite-memory-journal";
  init(): Promise<void>;
  upsert(op: QueuedSyncOperation): Promise<void>;
  readAll(): Promise<QueuedSyncOperation[]>;
  clearSynced(): Promise<void>;
}

function loadNativeExpoSqlite(): typeof SQLiteTypes {
  // Static string literal preserved for Metro bundler while avoiding eager load in Node Vitest
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("expo-sqlite") as typeof SQLiteTypes;
}

/**
 * Production on-device ACID SQLite queue storage driver using `expo-sqlite` SDK 52 async API.
 * Persists pending collection drafts, morning peshgi advances, and dismantling records on flash storage
 * across app restarts & low-battery shutdowns — while NEVER storing KYC files or bearer tokens.
 */
export class ExpoSqliteQueueDriver implements PersistentQueueDriver {
  readonly driverName = "expo-sqlite" as const;
  private dbPromise: Promise<SQLiteTypes.SQLiteDatabase> | null = null;

  constructor(private readonly dbFileName = "kabadiwala_field_v1.db") {}

  private getDb(): Promise<SQLiteTypes.SQLiteDatabase> {
    if (!this.dbPromise) {
      const SQLite = loadNativeExpoSqlite();
      this.dbPromise = SQLite.openDatabaseAsync(this.dbFileName);
    }
    return this.dbPromise;
  }

  async init(): Promise<void> {
    const db = await this.getDb();
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS offline_sync_queue (
        idempotency_key TEXT PRIMARY KEY NOT NULL,
        client_entity_id TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        created_at_iso TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        sync_status TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        server_summary_json TEXT
      );
    `);
  }

  async upsert(op: QueuedSyncOperation): Promise<void> {
    await this.init();
    const db = await this.getDb();
    await db.runAsync(
      `INSERT INTO offline_sync_queue (
        idempotency_key, client_entity_id, operation_type, created_at_iso,
        payload_json, sync_status, retry_count, server_summary_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        sync_status = excluded.sync_status,
        retry_count = excluded.retry_count,
        server_summary_json = excluded.server_summary_json;`,
      op.idempotencyKey,
      op.clientEntityId,
      op.operationType,
      op.createdAtIso,
      JSON.stringify(op.payload),
      op.syncStatus,
      op.retryCount,
      op.serverSummary ? JSON.stringify(op.serverSummary) : null
    );
  }

  async readAll(): Promise<QueuedSyncOperation[]> {
    await this.init();
    const db = await this.getDb();
    const rows = await db.getAllAsync<{
      idempotency_key: string;
      client_entity_id: string;
      operation_type: SupportedOfflineOpType;
      created_at_iso: string;
      payload_json: string;
      sync_status: SyncStatus;
      retry_count: number;
      server_summary_json: string | null;
    }>(`SELECT * FROM offline_sync_queue ORDER BY created_at_iso ASC;`);

    return rows.map((r) => ({
      idempotencyKey: r.idempotency_key,
      clientEntityId: r.client_entity_id,
      operationType: r.operation_type,
      createdAtIso: r.created_at_iso,
      payload: JSON.parse(r.payload_json) as Record<string, unknown>,
      syncStatus: r.sync_status,
      retryCount: r.retry_count,
      serverSummary: r.server_summary_json
        ? (JSON.parse(r.server_summary_json) as Record<string, unknown>)
        : undefined,
    }));
  }

  async clearSynced(): Promise<void> {
    await this.init();
    const db = await this.getDb();
    await db.runAsync(
      `DELETE FROM offline_sync_queue WHERE sync_status IN ('SYNCED', 'IDEMPOTENT_SKIPPED');`
    );
  }
}

/**
 * Deterministic serialized JSON journal driver simulating disk persistence across cold restarts
 * in non-Android runtimes (e.g., Node/Vitest CI tests or Expo Web preview).
 */
export class SerializedJournalQueueDriver implements PersistentQueueDriver {
  readonly driverName = "sqlite-memory-journal" as const;

  constructor(private readonly backingStore: Map<string, string> = new Map()) {}

  async init(): Promise<void> {
    // Ready immediately
  }

  async upsert(op: QueuedSyncOperation): Promise<void> {
    this.backingStore.set(op.idempotencyKey, JSON.stringify(op));
  }

  async readAll(): Promise<QueuedSyncOperation[]> {
    return Array.from(this.backingStore.values())
      .map((raw) => JSON.parse(raw) as QueuedSyncOperation)
      .sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso));
  }

  async clearSynced(): Promise<void> {
    for (const [k, raw] of this.backingStore.entries()) {
      const parsed = JSON.parse(raw) as QueuedSyncOperation;
      if (
        parsed.syncStatus === "SYNCED" ||
        parsed.syncStatus === "IDEMPOTENT_SKIPPED"
      ) {
        this.backingStore.delete(k);
      }
    }
  }
}

export class OfflineSyncQueue {
  private cache: QueuedSyncOperation[] = [];
  private readonly driver: PersistentQueueDriver;

  constructor(driver?: PersistentQueueDriver) {
    this.driver = driver ?? new ExpoSqliteQueueDriver();
  }

  private async withFallbackDriver<T>(
    fn: (d: PersistentQueueDriver) => Promise<T>,
    fallback: () => T
  ): Promise<T> {
    try {
      return await fn(this.driver);
    } catch {
      return fallback();
    }
  }

  async hydrateFromDisk(): Promise<readonly QueuedSyncOperation[]> {
    const loaded = await this.withFallbackDriver(
      (d) => d.readAll(),
      () => [...this.cache]
    );
    this.cache = loaded;
    return this.cache;
  }

  async enqueue(
    op: Omit<QueuedSyncOperation, "syncStatus" | "retryCount">
  ): Promise<QueuedSyncOperation> {
    const entry: QueuedSyncOperation = {
      ...op,
      syncStatus: "PENDING",
      retryCount: 0,
    };
    this.cache = [
      ...this.cache.filter((x) => x.idempotencyKey !== entry.idempotencyKey),
      entry,
    ];
    await this.withFallbackDriver(
      (d) => d.upsert(entry),
      () => undefined
    );
    return entry;
  }

  getAll(): readonly QueuedSyncOperation[] {
    return this.cache;
  }

  getPending(): readonly QueuedSyncOperation[] {
    return this.cache.filter((i) => i.syncStatus === "PENDING");
  }

  async clearCompleted(): Promise<readonly QueuedSyncOperation[]> {
    await this.withFallbackDriver(
      (d) => d.clearSynced(),
      () => undefined
    );
    this.cache = this.cache.filter(
      (i) => i.syncStatus !== "SYNCED" && i.syncStatus !== "IDEMPOTENT_SKIPPED"
    );
    return this.cache;
  }

  async flushBatchToServer(
    apiBaseUrl: string,
    accessToken: string,
    deviceLabel = "Expo SQLite Field Queue",
    fetchImpl: typeof fetch = fetch
  ): Promise<{ applied: number; skippedIdempotent: number; rejected: number }> {
    await this.hydrateFromDisk();
    const pending = this.cache.filter(
      (i) => i.syncStatus === "PENDING" || i.syncStatus === "CONFLICT_REVIEW"
    );
    if (pending.length === 0) {
      return { applied: 0, skippedIdempotent: 0, rejected: 0 };
    }

    for (const item of pending) {
      item.syncStatus = "SYNCING";
      await this.withFallbackDriver((d) => d.upsert(item), () => undefined);
    }

    try {
      const res = await fetchImpl(`${apiBaseUrl}/api/v1/sync/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          deviceLabel,
          operations: pending.map((p) => ({
            idempotencyKey: p.idempotencyKey,
            clientEntityId: p.clientEntityId,
            operationType: p.operationType,
            createdAtIso: p.createdAtIso,
            payload: p.payload,
          })),
        }),
      });

      const json = (await res.json()) as {
        success: boolean;
        data?: {
          summary: {
            newlyAppliedCount: number;
            idempotentSkippedCount: number;
            rejectedCount: number;
          };
          results: Array<{
            idempotencyKey: string;
            status: "APPLIED" | "IDEMPOTENT_REPLAY_IGNORED" | "REJECTED_VALIDATION";
            serverRecord?: Record<string, unknown>;
          }>;
        };
      };

      if (!res.ok || !json.success || !json.data) {
        for (const item of pending) {
          item.syncStatus = "PENDING";
          item.retryCount++;
          await this.withFallbackDriver((d) => d.upsert(item), () => undefined);
        }
        return { applied: 0, skippedIdempotent: 0, rejected: pending.length };
      }

      const resultByKey = new Map(
        json.data.results.map((r) => [r.idempotencyKey, r])
      );
      for (const item of pending) {
        const r = resultByKey.get(item.idempotencyKey);
        if (!r) {
          item.syncStatus = "PENDING";
        } else if (r.status === "APPLIED") {
          item.syncStatus = "SYNCED";
          item.serverSummary = r.serverRecord;
        } else if (r.status === "IDEMPOTENT_REPLAY_IGNORED") {
          item.syncStatus = "IDEMPOTENT_SKIPPED";
          item.serverSummary = r.serverRecord;
        } else {
          item.syncStatus = "CONFLICT_REVIEW";
        }
        await this.withFallbackDriver((d) => d.upsert(item), () => undefined);
      }

      return {
        applied: json.data.summary.newlyAppliedCount,
        skippedIdempotent: json.data.summary.idempotentSkippedCount,
        rejected: json.data.summary.rejectedCount,
      };
    } catch {
      for (const item of pending) {
        item.syncStatus = "PENDING";
        item.retryCount++;
        await this.withFallbackDriver((d) => d.upsert(item), () => undefined);
      }
      return { applied: 0, skippedIdempotent: 0, rejected: 0 };
    }
  }
}
