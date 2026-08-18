/**
 * Fault-injection style durability evidence (R2).
 *
 * Simulates SIGKILL mid-embed / mid-import by leaving `running` job rows and
 * reclaiming them the same way process restart does, then asserts SQLite
 * integrity_check still passes and progress is preserved for resume.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { checkSqliteIntegrity } from "./db/integrity";
import {
  reclaimOrphanedEmbeddingJobRows,
  reclaimOrphanedImportJobRows,
} from "./job-queue";
import type { ProcessProbe } from "./job-process";

function memoryDb(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE embedding_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'running',
      phase TEXT NOT NULL DEFAULT 'embedding',
      processed INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      current_provider TEXT,
      error TEXT,
      message TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      worker_pid INTEGER,
      lease_expires_at INTEGER,
      started_at INTEGER NOT NULL DEFAULT (unixepoch()),
      finished_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE import_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      content_hash TEXT,
      spool_path TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'zip',
      state TEXT NOT NULL DEFAULT 'running',
      phase TEXT NOT NULL DEFAULT 'writing',
      processed INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      message TEXT,
      started_at INTEGER NOT NULL DEFAULT (unixepoch()),
      finished_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE saved_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_key TEXT NOT NULL UNIQUE,
      href TEXT
    );
  `);
  return sqlite;
}

const deadWorkerProbe: ProcessProbe = {
  isAlive: () => false,
  isOwnedWorker: () => true,
  signal: () => true,
  sleepMs: () => undefined,
};

describe("fault injection durability", () => {
  it("SIGKILL mid-embed: reclaim resumes with processed preserved + integrity ok", () => {
    const sqlite = memoryDb();
    // Simulate committed embedding chunks before the kill.
    sqlite
      .prepare(
        `INSERT INTO saved_items (media_key, href) VALUES ('k1', 'https://x/1'), ('k2', 'https://x/2')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO embedding_jobs
          (target, state, phase, processed, total, worker_pid, lease_expires_at)
         VALUES ('local', 'running', 'embedding', 2, 10, 4242, ?)`,
      )
      .run(Math.floor(Date.now() / 1000) - 120);

    const result = reclaimOrphanedEmbeddingJobRows(sqlite, {
      processProbe: deadWorkerProbe,
      killGraceMs: 0,
    });
    expect(result.resumed).toBe(1);

    const job = sqlite
      .prepare(
        `SELECT state, processed, total, worker_pid AS workerPid
         FROM embedding_jobs WHERE id = 1`,
      )
      .get() as {
      state: string;
      processed: number;
      total: number;
      workerPid: number | null;
    };
    expect(job.state).toBe("pending");
    expect(job.processed).toBe(2);
    expect(job.total).toBe(10);
    expect(job.workerPid).toBeNull();

    const integrity = checkSqliteIntegrity(sqlite);
    expect(integrity.ok).toBe(true);
    expect(integrity.detail).toBe("ok");

    const itemCount = (
      sqlite.prepare(`SELECT count(*) AS c FROM saved_items`).get() as {
        c: number;
      }
    ).c;
    expect(itemCount).toBe(2);
  });

  it("SIGKILL mid-import-write: spool present → requeue; integrity ok", () => {
    const sqlite = memoryDb();
    // First write batch already committed before the kill.
    sqlite
      .prepare(
        `INSERT INTO saved_items (media_key, href) VALUES ('batch1-a', 'https://x/a')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO import_jobs (filename, spool_path, state, phase, processed, total)
         VALUES ('export.zip', '/tmp/fake-spool.zip', 'running', 'writing', 1, 5)`,
      )
      .run();

    const result = reclaimOrphanedImportJobRows(sqlite, {
      spoolExists: () => true,
    });
    expect(result).toEqual({ requeued: 1, failed: 0 });

    const job = sqlite
      .prepare(`SELECT state, processed FROM import_jobs WHERE id = 1`)
      .get() as { state: string; processed: number };
    expect(job.state).toBe("pending");
    expect(job.processed).toBe(1);

    expect(checkSqliteIntegrity(sqlite).ok).toBe(true);
  });

  it("SIGKILL mid-import with missing spool → failed; committed rows stay consistent", () => {
    const sqlite = memoryDb();
    sqlite
      .prepare(
        `INSERT INTO saved_items (media_key) VALUES ('kept')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO import_jobs (filename, spool_path, state)
         VALUES ('gone.zip', '/tmp/missing-spool.zip', 'running')`,
      )
      .run();

    const result = reclaimOrphanedImportJobRows(sqlite, {
      spoolExists: () => false,
    });
    expect(result).toEqual({ requeued: 0, failed: 1 });

    const job = sqlite
      .prepare(`SELECT state FROM import_jobs WHERE id = 1`)
      .get() as { state: string };
    expect(job.state).toBe("failed");
    expect(checkSqliteIntegrity(sqlite).ok).toBe(true);
  });
});
