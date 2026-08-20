/**
 * App-wide storage entry (`getStorage`).
 *
 * SQLite remains the default. A postgres:// INSTAGRAM_SAVES_DATABASE_URL
 * selects the Postgres Pool + Drizzle migration backend.
 *
 * Import from `@/lib/storage` (not `@/lib/db`) to avoid cycles with catalog
 * adapters that still call into queries → getSqlite.
 */
import type { Storage } from "./ports";
import { closeSqlite, getSqlite } from "./sqlite/connection";
import { createSqliteStorage } from "./sqlite/create";
import {
  closePostgres,
  getPostgresPool,
  isPostgresConfigured,
} from "./postgres/connection";
import { createPostgresStorage } from "./postgres/create";
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
export { createPostgresStorage } from "./postgres/create";
export {
  createPostgresPool,
  getPostgresPool,
  isPostgresConfigured,
} from "./postgres/connection";
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
  if (isPostgresConfigured()) {
    const storage = createPostgresStorage(await getPostgresPool());
    if (!isJobWorkerProcess()) {
      await storage.jobs.reclaimOrphanedEmbeddingJobs();
      await storage.jobs.reclaimOrphanedImportJobs();
    }
    return storage;
  }
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

/** Close the selected engine and drop the Storage cache. */
export function closeStorage() {
  clearStorageCache();
  if (isPostgresConfigured()) {
    void closePostgres();
  } else {
    closeSqlite();
  }
}
