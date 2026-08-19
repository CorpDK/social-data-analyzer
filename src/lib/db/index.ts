/**
 * Compatibility facade for the SQLite connection.
 *
 * Connection lifecycle lives in `src/lib/storage/sqlite/connection.ts`.
 * Prefer `getStorage()` from `src/lib/storage` for new code (ME-1).
 * Sync `getSqlite` / `getDb` call sites convert in ME-2.
 *
 * Ownership: Drizzle (`getDb` + `./schema`) owns the relational catalog;
 * raw SQL owns FTS/vec/jobs/`app_settings`/SCHEMA_VERSION DDL (see `./ddl.ts`).
 * See docs/db-boundary.md — do not add Drizzle Kit migrations here.
 *
 * Note: this module must not import `src/lib/storage` (adapters → queries → here).
 */
export {
  SCHEMA_VERSION,
  VEC_DIMENSIONS,
  ensureDatabaseSchema,
  recreateEmptySearchIndexes,
  getSqlite,
  getDb,
  closeSqlite,
  installSqliteConnectionForTests,
  resetDrizzleForTests,
  schema,
} from "../storage/sqlite/connection";
