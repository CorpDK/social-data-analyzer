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
  SCHEMA_VERSION,
  VEC_DIMENSIONS,
  ensureDatabaseSchema,
} from "./ddl";
import * as schema from "./schema";

export { SCHEMA_VERSION, VEC_DIMENSIONS, ensureDatabaseSchema } from "./ddl";

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

  // This is intentionally connection-startup work, not schema-ensure work:
  // HMR may re-run schema ensure while a real in-process job is still active.
  // Interrupted embedding jobs re-queue as pending so rebuild can resume
  // (skip already-embedded ids) instead of failing and leaving a partial index.
  sqlite
    .prepare(
      `UPDATE embedding_jobs
       SET state = 'cancelled',
           message = 'Cancelled (interrupted while cancel was requested)',
           error = NULL,
           finished_at = unixepoch(),
           updated_at = unixepoch()
       WHERE state = 'running' AND cancel_requested = 1`,
    )
    .run();

  sqlite
    .prepare(
      `UPDATE embedding_jobs
       SET state = 'pending',
           phase = 'queued',
           message = CASE
             WHEN processed > 0 THEN 'Resuming after server restart…'
             ELSE 'Re-queued after server restart'
           END,
           error = NULL,
           finished_at = NULL,
           updated_at = unixepoch()
       WHERE state = 'running' AND cancel_requested = 0`,
    )
    .run();

  // Import jobs: re-queue when the spool file is still on disk; otherwise fail.
  // Full re-run from spool (idempotent merge) — not mid-phase resume.
  const orphaned = sqlite
    .prepare(
      `SELECT id, spool_path FROM import_jobs WHERE state = 'running'`,
    )
    .all() as Array<{ id: number; spool_path: string }>;

  for (const row of orphaned) {
    const spoolExists =
      typeof row.spool_path === "string" &&
      row.spool_path.length > 0 &&
      fs.existsSync(row.spool_path);

    if (spoolExists) {
      sqlite
        .prepare(
          `UPDATE import_jobs
           SET state = 'pending',
               phase = 'queued',
               cancel_requested = 0,
               message = 'Re-queued after server restart',
               error = NULL,
               finished_at = NULL,
               updated_at = unixepoch()
           WHERE id = ?`,
        )
        .run(row.id);
    } else {
      sqlite
        .prepare(
          `UPDATE import_jobs
           SET state = 'failed',
               error = 'Interrupted by server restart (upload spool missing)',
               message = 'Job interrupted by server restart',
               finished_at = unixepoch(),
               updated_at = unixepoch()
           WHERE id = ?`,
        )
        .run(row.id);
    }
  }
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

/**
 * Drop and recreate empty FTS + vector indexes so the app stays usable after
 * a content wipe. Does not touch `app_settings` or keyring secrets.
 */
export function recreateEmptySearchIndexes(
  sqlite: Database.Database = getSqlite(),
) {
  sqlite.exec(`
    DROP TABLE IF EXISTS saved_items_fts;
    CREATE VIRTUAL TABLE saved_items_fts USING fts5(
      author_username,
      shortcode,
      media_key,
      media_type,
      collections,
      tokenize = 'porter unicode61 remove_diacritics 1'
    );
  `);

  sqlite.exec(`
    DROP TABLE IF EXISTS liked_items_fts;
    CREATE VIRTUAL TABLE liked_items_fts USING fts5(
      author_username,
      shortcode,
      media_key,
      media_type,
      source,
      tokenize = 'porter unicode61 remove_diacritics 1'
    );
  `);

  for (const index of ["local", "ollama", "openai", "voyage"] as const) {
    for (const prefix of ["saved_items_vec", "liked_items_vec"] as const) {
      const table = `${prefix}_${index}`;
      sqlite.exec(`
        DROP TABLE IF EXISTS ${table};
        CREATE VIRTUAL TABLE ${table} USING vec0(
          item_id INTEGER PRIMARY KEY,
          embedding FLOAT[${VEC_DIMENSIONS}]
        );
      `);
    }
  }

  sqlite.exec(`DROP TABLE IF EXISTS saved_items_vec_remote;`);
}

export { schema };
