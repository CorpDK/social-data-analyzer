import type Database from "better-sqlite3";
import type { Storage } from "../ports";
import { createSqliteCatalogStore } from "./catalog";
import { createSqliteSearchIndex } from "./search";
import { createSqliteJobStore } from "./jobs";
import { createSqliteSettingsStore } from "./settings";
import { createSqliteMaintenanceOps } from "./maintenance";

/**
 * Build a Storage bundle over an opened SQLite handle.
 * For unit tests, prefer `installSqliteConnectionForTests(sqlite)` first so
 * domain modules that still call getSqlite() see the same connection.
 */
export function createSqliteStorage(sqlite: Database.Database): Storage {
  return {
    catalog: createSqliteCatalogStore(sqlite),
    search: createSqliteSearchIndex(sqlite),
    jobs: createSqliteJobStore(sqlite),
    settings: createSqliteSettingsStore(sqlite),
    maintenance: createSqliteMaintenanceOps(sqlite),
  };
}
