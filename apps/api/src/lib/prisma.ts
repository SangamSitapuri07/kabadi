import EventEmitter from "events";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { env } from "../config/env";
import { API_PACKAGE_ROOT, WORKSPACE_ROOT } from "./paths";

/**
 * Direct zero-socket `pg.Pool` subclass backed by embedded PostgreSQL 16 (PGlite)
 * for local/sandbox & test execution when `USE_EXTERNAL_POSTGRES=false`.
 * Preserves 100% identical PostgreSQL 16 SQL, enums, CHECK constraints, and PL/pgSQL triggers!
 */
class EmbeddedPGlitePool extends Pool {
  private db: PGlite;
  private txChain: Promise<void> = Promise.resolve();

  constructor(db: PGlite) {
    super({ connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/postgres" });
    this.db = db;
  }

  private async runQuery(
    queryInput:
      | string
      | {
          text: string;
          values?: unknown[];
          rowMode?: "array";
        },
    valuesArg?: unknown[]
  ) {
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

    // node-postgres passes raw JSON strings to Prisma's custom OID 114/3802 parser,
    // whereas PGlite pre-parses JSON/JSONB into JS objects by default.
    const rows =
      rowMode === "array"
        ? (res.rows as unknown[][]).map((row) =>
            row.map((cell, idx) => {
              const oid = res.fields[idx]?.dataTypeID;
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
      fields: res.fields.map((f) => ({
        name: f.name,
        dataTypeID: f.dataTypeID,
      })),
      rowCount: res.affectedRows ?? res.rows.length,
      command: "",
      oid: 0,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override query(queryTextOrConfig: any, values?: any): any {
    // Wait for any active interactive transaction client to release before running top-level pool query
    return this.txChain.then(() => this.runQuery(queryTextOrConfig, values));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async connect(): Promise<any> {
    let releaseLock!: () => void;
    const prevLock = this.txChain;
    this.txChain = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    await prevLock;

    const emitter = new EventEmitter();
    let released = false;
    return Object.assign(emitter, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (q: any, vals?: any) => this.runQuery(q, vals),
      release: () => {
        if (!released) {
          released = true;
          releaseLock();
        }
      },
    });
  }

  override async end(): Promise<void> {
    await this.txChain;
  }
}

let prismaInstance: PrismaClient | null = null;
let poolInstance: Pool | null = null;
let pgliteInstance: PGlite | null = null;
let initPromise: Promise<PrismaClient> | null = null;

export async function getPrisma(): Promise<PrismaClient> {
  if (prismaInstance) return prismaInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const migrationPath = path.join(
      API_PACKAGE_ROOT,
      "prisma",
      "migrations",
      "0001_initial_foundation",
      "migration.sql"
    );
    const migrationSql = fs.readFileSync(migrationPath, "utf8");

    if (env.USE_EXTERNAL_POSTGRES) {
      poolInstance = new Pool({
        connectionString: env.DATABASE_URL,
        max: 10,
      });
      await poolInstance.query(migrationSql);
    } else {
      const dataDir =
        env.NODE_ENV === "test"
          ? undefined
          : path.join(WORKSPACE_ROOT, ".data", "pgdata");

      if (dataDir) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      pgliteInstance = new PGlite(dataDir);
      await pgliteInstance.waitReady;
      await pgliteInstance.exec(migrationSql);

      poolInstance = new EmbeddedPGlitePool(pgliteInstance);
    }

    const adapter = new PrismaPg(poolInstance);
    prismaInstance = new PrismaClient({ adapter });
    await prismaInstance.$connect();
    return prismaInstance;
  })();

  return initPromise;
}

export async function closePrisma(): Promise<void> {
  if (prismaInstance) {
    await prismaInstance.$disconnect();
    prismaInstance = null;
  }
  if (poolInstance) {
    await poolInstance.end();
    poolInstance = null;
  }
  if (pgliteInstance) {
    await pgliteInstance.close();
    pgliteInstance = null;
  }
  initPromise = null;
}
