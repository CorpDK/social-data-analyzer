/**
 * App-wide storage entry (`getStorage`).
 *
 * ME-2: lazy cached init promise — schema via getSqlite(), then async orphan
 * reclaim, then SQLite ports. Engine selection arrives in ME-4.
 *
 * Import from `@/lib/storage` (not `@/lib/db`) to avoid cycles with catalog
 * adapters that still call into queries → getSqlite.
 */
import type { Storage } from "./ports";
import { closeSqlite, getSqlite } from "./sqlite/connection";
import { createSqliteStorage } from "./sqlite/create";
import {
  reclaimOrphanedEmbeddingJobRows,
  reclaimOrphanedImportJobRows,
} from "../job-queue";

export type { Storage, EngineInfo } from "./ports";
export type {
  CatalogStore,
  SearchIndex,
  JobStore,
  SettingsStore,
  MaintenanceOps,
} from "./ports";

export { createSqliteStorage } from "./sqlite/create";
export {
  installSqliteConnectionForTests,
  resetDrizzleForTests,
  ensureDatabaseSchema,
  SCHEMA_VERSION,
  getSqlite,
  closeSqlite,
} from "./sqlite/connection";

const globalForStorage = globalThis as unknown as {
  instagramSavesStorage?: Storage;
  instagramSavesStorageInit?: Promise<Storage>;
};

/**
 * True inside `scripts/embedding-worker.ts` (and any inline worker run). Such a
 * process must never reclaim job rows: its own job is legitimately `running`,
 * and re-queuing it as `pending` lets the parent queue start a second worker
 * for the same job.
 */
function isJobWorkerProcess(): boolean {
  return process.env.EMBEDDING_WORKER_CHILD === "1";
}

async function reclaimJobsAfterProcessRestart(sqlite: ReturnType<typeof getSqlite>) {
  if (isJobWorkerProcess()) return;
  await reclaimOrphanedEmbeddingJobRows(sqlite);
  reclaimOrphanedImportJobRows(sqlite);
}

async function initStorage(): Promise<Storage> {
  const sqlite = getSqlite();
  await reclaimJobsAfterProcessRestart(sqlite);
  return createSqliteStorage(sqlite);
}

/**
 * Cached Storage for the process. Opens SQLite (WAL, schema), async orphan
 * reclaim, then wraps the five ports. Concurrent callers share one init promise.
 */
export async function getStorage(): Promise<Storage> {
  if (globalForStorage.instagramSavesStorage) {
    return globalForStorage.instagramSavesStorage;
  }
  if (!globalForStorage.instagramSavesStorageInit) {
    globalForStorage.instagramSavesStorageInit = initStorage()
      .then((storage) => {
        globalForStorage.instagramSavesStorage = storage;
        return storage;
      })
      .catch((error) => {
        globalForStorage.instagramSavesStorageInit = undefined;
        throw error;
      });
  }
  return globalForStorage.instagramSavesStorageInit;
}

/** Clear cached Storage (does not close SQLite). Used by tests. */
export function clearStorageCache() {
  globalForStorage.instagramSavesStorage = undefined;
  globalForStorage.instagramSavesStorageInit = undefined;
}

/** Close SQLite and drop the Storage cache. */
export function closeStorage() {
  clearStorageCache();
  closeSqlite();
}
