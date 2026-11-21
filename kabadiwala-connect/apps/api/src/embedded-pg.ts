// An embedded PostgreSQL 16 that speaks the `pg.Pool` interface.
//
// Why this exists: kabadiwala-connect's authentication is Better Auth, and Better
// Auth takes a `pg.Pool` and runs its own SQL and migrations against it. Until now
// that meant every developer needed a real PostgreSQL server (or a cloud one) just
// to see the sign-in page work. This makes the app runnable with none of that.
//
// It is a development default, not a production database:
//   USE_EXTERNAL_POSTGRES=true + DATABASE_URL=postgresql://...  -> use your own
//   otherwise                                                   -> embed one
//
// PGlite is real PostgreSQL 16 compiled to WebAssembly, so the SQL Better Auth
// emits -- enums, constraints, transactions, PL/pgSQL -- behaves as it does on a
// server. What it lacks is concurrency: there is one connection, so every query is
// serialised through a promise chain. For a local dev server that is the right
// trade; for production it would not be.
import EventEmitter from "events";
import fs from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import type pg from "pg";

type RowMode = { text: string; values?: unknown[]; rowMode?: "array" };

interface QueryResult {
  rows: unknown[];
  fields: Array<{ name: string; dataTypeID: number }>;
  rowCount: number;
  command: string;
  oid: number;
}

/**
 * Shaped like `pg.Pool` for the parts Better Auth and this app use: `query`,
 * `connect`, `on`, `end`.
 *
 * It deliberately does NOT extend `pg.Pool`. Extending would inherit real socket
 * code and its constructor would open connections that go nowhere; Better Auth only
 * needs the four members below, and an explicit class makes that dependency visible.
 */
export class EmbeddedPglitePool extends EventEmitter {
  private db: PGlite;
  private txChain: Promise<void> = Promise.resolve();

  constructor(db: PGlite) {
    super();
    this.db = db;
    // `pg.Pool` emits 'error' for idle-client failures. Better Auth registers a
    // listener; without the method that registration would throw.
    this.on("error", () => {
      /* handled by the caller's listener */
    });
  }

  private async runQuery(
    queryInput: string | RowMode,
    valuesArg?: unknown[]
  ): Promise<QueryResult> {
    const sql = typeof queryInput === "string" ? queryInput : queryInput.text;
    const params =
      typeof queryInput === "string" ? valuesArg ?? [] : queryInput.values ?? [];
    const rowMode =
      typeof queryInput === "object" && queryInput.rowMode === "array"
        ? "array"
        : undefined;

    const res = await this.db.query(sql, params as never[], {
      ...(rowMode ? { rowMode } : {}),
    });

    // `pg` hands Prisma/Better Auth raw JSON strings for json/jsonb columns, while
    // PGlite pre-parses them into objects. Normalising here keeps one behaviour.
    const rows =
      rowMode === "array"
        ? (res.rows as unknown[][]).map((row) =>
            row.map((cell, index) => {
              const oid = res.fields[index]?.dataTypeID;
              if (
                (oid === 114 || oid === 3802) &&
                cell !== null &&
                typeof cell === "object"
              ) {
                return JSON.stringify(cell);
              }
              return cell;
            })
          )
        : res.rows;

    return {
      rows,
      fields: res.fields.map((field) => ({
        name: field.name,
        dataTypeID: field.dataTypeID,
      })),
      // PGlite reports `affectedRows` for writes and `rows.length` for reads --
      // but it reports `0` for a read rather than omitting the field, so `??`
      // picks the 0 and every SELECT looks empty to `rowCount` checks.
      //
      // That is not a cosmetic difference. `createDevProvisioner` asks
      // `SELECT 1 FROM "user" WHERE id=$1` and treats `rowCount === 0` as "no such
      // identity, refuse"; with this bug it refused every account, so a test
      // sign-in created the auth user and then reported 'unavailable'.
      //
      // A statement that returned rows has that many rows; only a statement that
      // returned none falls back to the write count.
      rowCount: res.rows.length > 0 ? res.rows.length : (res.affectedRows ?? 0),
      command: "",
      oid: 0,
    };
  }

  // Better Auth calls `pool.query(...)`, sometimes with a callback-free promise and
  // sometimes with a SQL object. Both forms land here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(queryTextOrConfig: any, values?: any): Promise<QueryResult> {
    return this.txChain.then(() => this.runQuery(queryTextOrConfig, values));
  }

  /**
   * Hands out a single-connection object for callers that need one (Better Auth's
   * migrator does). Concurrent callers are queued: the previous holder must call
   * `release()` before the next is answered.
   */
  async connect(): Promise<{
    query: (q: unknown, vals?: unknown[]) => Promise<QueryResult>;
    release: () => void;
  }> {
    let releaseLock!: () => void;
    const previous = this.txChain;
    this.txChain = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    await previous;

    let released = false;
    return {
      query: (q: unknown, vals?: unknown[]) => this.runQuery(q as string | RowMode, vals),
      release: () => {
        if (!released) {
          released = true;
          releaseLock();
        }
      },
    };
  }

  async end(): Promise<void> {
    await this.txChain;
  }
}

let pool: pg.Pool | null = null;
let pglite: PGlite | null = null;

/**
 * Returns the pool the API should use, embedded or external.
 *
 * The data directory is on disk and survives restarts, so a signed-in session and a
 * created account are still there the next morning -- which an in-memory database
 * would not give, and which is the difference between "it works" and "it works until
 * you reload".
 */
/**
 * Typed as `pg.Pool` on purpose.
 *
 * Every caller -- nine CLIs, Better Auth, the stores -- is written against `pg.Pool`,
 * and the embedded stand-in implements exactly the members they use. Returning the
 * concrete class would force a cast at every call site for no gain; the honest place
 * to record "this is not a real pg.Pool" is here, once.
 */
export async function getDatabasePool(databaseURL: string | undefined): Promise<pg.Pool> {
  if (pool) return pool;

  const useExternal = process.env.USE_EXTERNAL_POSTGRES === "true";
  if (useExternal && databaseURL) {
    // The caller wanted their own server; hand `
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseURL, max: 5 });
    return pool;
  }

  const dataDir = process.env.EMBEDDED_PG_DATA_DIR ?? path.resolve(process.cwd(), ".data/pgdata-next");
  fs.mkdirSync(dataDir, { recursive: true });
  pglite = new PGlite(dataDir);
  await pglite.waitReady;
  pool = new EmbeddedPglitePool(pglite) as unknown as pg.Pool;
  return pool;
}

export async function closeDatabasePool(): Promise<void> {
  if (pglite) {
    await pglite.close();
    pglite = null;
  }
  pool = null;
}
