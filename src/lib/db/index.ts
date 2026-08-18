/**
 * SQLite connection lifecycle (`getSqlite` / `getDb` / close).
 *
 * Ownership: Drizzle (`getDb` + `./schema`) owns the relational catalog;
 * raw SQL owns FTS/vec/jobs/`app_settings`/SCHEMA_VERSION DDL (see `./ddl.ts`).
 * See docs/db-boundary.md — do not add Drizzle Kit migrations here.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as sqliteVec from "sqlite-vec";
import {
  reclaimOrphanedEmbeddingJobRows,
  reclaimOrphanedImportJobRows,
} from "../job-queue";
import {
  SCHEMA_VERSION,
  ensureDatabaseSchema,
} from "./ddl";
import * as schema from "./schema";

export {
  SCHEMA_VERSION,
  VEC_DIMENSIONS,
  ensureDatabaseSchema,
  recreateEmptySearchIndexes,
} from "./ddl";

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

/**
 * True inside `scripts/embedding-worker.ts` (and any inline worker run). Such a
 * process must never reclaim job rows: its own job is legitimately `running`,
 * and re-queuing it as `pending` lets the parent queue start a second worker
 * for the same job.
 */
function isJobWorkerProcess(): boolean {
  return process.env.EMBEDDING_WORKER_CHILD === "1";
}

function reclaimJobsAfterProcessRestart(sqlite: Database.Database) {
  if (isJobWorkerProcess()) return;

  // Connection-startup reclaim (not schema-ensure): HMR may re-run schema
  // ensure while an in-process job is still active. Shared helpers match the
  // HMR reclaim paths in search/jobs + import/jobs.
  reclaimOrphanedEmbeddingJobRows(sqlite);
  reclaimOrphanedImportJobRows(sqlite);
}
function markSchemaApplied() {
  globalForDb.schemaVersion = SCHEMA_VERSION;
}

let schemaEnsuredForModule = false;

export function getSqlite() {
  if (!globalForDb.sqlite) {
    const sqlite = createDatabaseConnection();
    ensureDatabaseSchema(sqlite);
    markSchemaApplied();
    reclaimJobsAfterProcessRestart(sqlite);
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

// Next.js preserves the connection on globalThis across HMR. Re-ensure once as
// soon as this module is re-evaluated so newly added idempotent DDL takes effect
// without opening another Database handle or requiring a server restart.
if (globalForDb.sqlite && process.env.NODE_ENV !== "production") {
  ensureDatabaseSchema(globalForDb.sqlite);
  markSchemaApplied();
  schemaEnsuredForModule = true;
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

export { schema };
