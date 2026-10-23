export interface PersistedOfflineOp {
  idempotencyKey: string;
  clientEntityId: string;
  operationType: "DRAFT_LISTING_CREATE" | "KHATA_ADVANCE_RECORD" | "DISMANTLING_LOG";
  label: string;
  payload: Record<string, unknown>;
  queuedAtIso: string;
}

const DB_NAME = "kabadiwala_offline_db";
const DB_VERSION = 1;
const STORE_NAME = "pending_sync_ops";
const FALLBACK_LS_KEY = "kabadiwala_pending_sync_ops_v1";

function openOfflineDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !("indexedDB" in window)) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "idempotencyKey" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB"));
  });
}

export async function readAllOfflineOpsFromIdb(): Promise<{
  items: PersistedOfflineOp[];
  engine: "IndexedDB" | "localStorage";
}> {
  try {
    const db = await openOfflineDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        db.close();
        const list = (req.result as PersistedOfflineOp[]).sort((a, b) =>
          a.queuedAtIso.localeCompare(b.queuedAtIso)
        );
        resolve({ items: list, engine: "IndexedDB" });
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch {
    if (typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem(FALLBACK_LS_KEY);
        return {
          items: raw ? (JSON.parse(raw) as PersistedOfflineOp[]) : [],
          engine: "localStorage",
        };
      } catch {
        return { items: [], engine: "localStorage" };
      }
    }
    return { items: [], engine: "IndexedDB" };
  }
}

export async function putOfflineOpInIdb(item: PersistedOfflineOp): Promise<void> {
  try {
    const db = await openOfflineDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(item);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    if (typeof window !== "undefined") {
      const current = await readAllOfflineOpsFromIdb();
      const updated = [
        ...current.items.filter((x) => x.idempotencyKey !== item.idempotencyKey),
        item,
      ];
      window.localStorage.setItem(FALLBACK_LS_KEY, JSON.stringify(updated));
    }
  }
}

export async function clearOfflineOpsInIdb(): Promise<void> {
  try {
    const db = await openOfflineDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(FALLBACK_LS_KEY);
    }
  }
}
