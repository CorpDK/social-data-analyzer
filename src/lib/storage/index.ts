/**
 * App-wide storage entry (`getStorage`).
 *
 * ME-1: async ports + SQLite behind them. ME-2 async-ifies call sites.
 * Engine selection (`INSTAGRAM_SAVES_DATABASE_URL`) arrives in ME-4.
 *
 * Import from `@/lib/storage` (not `@/lib/db`) to avoid cycles with catalog
 * adapters that still call into queries → getSqlite.
 */
import type { Storage } from "./ports";
import { closeSqlite, getSqlite } from "./sqlite/connection";
import { createSqliteStorage } from "./sqlite/create";

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
};

/**
 * Cached Storage for the process. Opens SQLite (WAL, schema, orphan reclaim)
 * via getSqlite(), then wraps it in the five ports.
 */
export async function getStorage(): Promise<Storage> {
  if (globalForStorage.instagramSavesStorage) {
    return globalForStorage.instagramSavesStorage;
  }
  const sqlite = getSqlite();
  const storage = createSqliteStorage(sqlite);
  globalForStorage.instagramSavesStorage = storage;
  return storage;
}

/** Clear cached Storage (does not close SQLite). Used by tests. */
export function clearStorageCache() {
  globalForStorage.instagramSavesStorage = undefined;
}

/** Close SQLite and drop the Storage cache. */
export function closeStorage() {
  clearStorageCache();
  closeSqlite();
}
