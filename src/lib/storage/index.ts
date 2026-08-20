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
import Database from "better-sqlite3";
import path from "node:path";
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
import {
  type StorageEngineConfig,
  readStorageEngineConfig,
  storageEnginePublicStatus,
  writeStorageEngineConfig,
} from "./engine-config";
import { getLibraryBusyState, LibraryBusyError } from "../settings/library-busy";
import { currentLibraryStatus } from "./library-status";

export type {
  Storage,
  EngineInfo,
  LibraryStatus,
  LibraryStatusPort,
  LibraryStatusState,
} from "./ports";
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
export {
  readStorageEngineConfig,
  storageEnginePublicStatus,
  type StorageEngineConfig,
} from "./engine-config";

export async function getLibraryStatus() {
  const inProgress = currentLibraryStatus();
  if (inProgress?.state === "updating") return inProgress;
  try {
    return await (await getStorage()).libraryStatus.getStatus();
  } catch (error) {
    const status = currentLibraryStatus();
    if (status) return status;
    const current = storageEnginePublicStatus();
    return {
      engine: current.engine,
      displayName: current.displayName,
      location:
        current.engine === "sqlite"
          ? current.sqlitePath
          : (current.postgresUrl ?? "Configured PostgreSQL database"),
      locationFolder:
        current.engine === "sqlite" ? path.dirname(current.sqlitePath) : null,
      state: "apply_failed" as const,
      appliedMigrations: 0,
      pendingMigrations: 0,
      technicalDetail:
        error instanceof Error ? error.message : "The library could not be opened.",
    };
  }
}

export async function retryLibraryUpdate() {
  const config = readStorageEngineConfig();
  if (config.engine !== "sqlite") {
    throw new Error("PostgreSQL update recovery is available in Advanced storage.");
  }

  const probe = new Database(config.sqlitePath);
  try {
    const busy = getLibraryBusyState(probe, "update the library");
    if (busy.busy) throw new LibraryBusyError(busy.reason);
  } finally {
    probe.close();
  }

  clearStorageCache();
  closeSqlite();
  await getStorage();
  return getLibraryStatus();
}

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
  closeSqlite();
  void closePostgres();
}

/** Activate a verified engine target and reopen storage against it. */
export async function switchStorageEngine(
  config: StorageEngineConfig,
): Promise<Storage> {
  clearStorageCache();
  closeSqlite();
  await closePostgres();
  writeStorageEngineConfig(config);
  return getStorage();
}
