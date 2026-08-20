/**
 * SQLite connection lifecycle — moved behind storage/ for ME-1/ME-2.
 *
 * Ownership: Drizzle Kit owns plain tables; `db/ddl.ts` owns only FTS5/vec0
 * virtual tables and the greenfield SCHEMA_VERSION stamp.
 *
 * Prefer `getStorage()` from `src/lib/storage` (lazy init + orphan reclaim).
 * `getSqlite` / `getDb` open/schema-ensure only — no top-level HMR ensure.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as sqliteVec from "sqlite-vec";
import {
  SCHEMA_VERSION,
  ensureDatabaseSchema,
} from "../../db/ddl";
import * as schema from "./schema";

export {
  SCHEMA_VERSION,
  VEC_DIMENSIONS,
  ensureDatabaseSchema,
  recreateEmptySearchIndexes,
} from "../../db/ddl";

export { schema };

const dataDir = path.join(process.cwd(), "data");
const dbPath =
  process.env.INSTAGRAM_SAVES_DB ??
  path.join(dataDir, "instagram-saves.db");

const globalForDb = globalThis as unknown as {
  sqlite?: Database.Database;
  db?: ReturnType<typeof drizzle<typeof schema>>;
  schemaVersion?: number;
};

function createDatabaseConnection() {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(dbPath);

  // WAL: readers don't block writers; crash-safe append log.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");

  sqliteVec.load(sqlite);

  return sqlite;
}

function markSchemaApplied() {
  globalForDb.schemaVersion = SCHEMA_VERSION;
}

let schemaEnsuredForModule = false;

/**
 * Open (or return) the process SQLite handle and run pending migrations.
 * Orphan job reclaim runs from `getStorage()` init (async), not here.
 */
export function getSqlite() {
  if (!globalForDb.sqlite) {
    const sqlite = createDatabaseConnection();
    ensureDatabaseSchema(sqlite);
    markSchemaApplied();
    globalForDb.sqlite = sqlite;
    schemaEnsuredForModule = true;
  } else if (!schemaEnsuredForModule) {
    const persistedVersion = globalForDb.sqlite.pragma("user_version", {
      simple: true,
    }) as number;
    if (
      process.env.NODE_ENV !== "production" ||
      globalForDb.schemaVersion !== SCHEMA_VERSION ||
      persistedVersion !== SCHEMA_VERSION
    ) {
      ensureDatabaseSchema(globalForDb.sqlite);
      markSchemaApplied();
    }
    schemaEnsuredForModule = true;
  }
  return globalForDb.sqlite;
}

/**
 * Close the shared connection and release its file descriptors. Used by
 * short-lived processes (the embedding worker) on every exit path.
 */
export function closeSqlite() {
  const sqlite = globalForDb.sqlite;
  if (!sqlite) return;
  globalForDb.sqlite = undefined;
  globalForDb.db = undefined;
  schemaEnsuredForModule = false;
  try {
    sqlite.close();
  } catch {
    // already closed
  }
}

export function getDb() {
  if (!globalForDb.db) {
    globalForDb.db = drizzle(getSqlite(), { schema });
  }
  return globalForDb.db;
}

/**
 * Install an already-opened Database as the process singleton (unit tests).
 * Caller must have applied schema / pragmas / sqlite-vec as needed.
 */
export function installSqliteConnectionForTests(sqlite: Database.Database) {
  if (globalForDb.sqlite && globalForDb.sqlite !== sqlite) {
    try {
      globalForDb.sqlite.close();
    } catch {
      // already closed
    }
  }
  globalForDb.sqlite = sqlite;
  globalForDb.db = undefined;
  globalForDb.schemaVersion = SCHEMA_VERSION;
  schemaEnsuredForModule = true;
}

/** Drop the Drizzle wrapper so the next getDb() rebuilds against current sqlite. */
export function resetDrizzleForTests() {
  globalForDb.db = undefined;
}
