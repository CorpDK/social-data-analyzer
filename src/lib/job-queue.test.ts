import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  prepareOrphanEmbeddingWorkerForReclaim,
  reclaimOrphanedEmbeddingJobRows,
} from "./job-queue";
import type { ProcessProbe } from "./job-process";

function memoryDbWithJobs(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE embedding_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'running',
      phase TEXT NOT NULL DEFAULT 'queued',
      processed INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      current_provider TEXT,
      error TEXT,
      message TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      worker_pid INTEGER,
      started_at INTEGER NOT NULL DEFAULT (unixepoch()),
      finished_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  return sqlite;
}

describe("prepareOrphanEmbeddingWorkerForReclaim", () => {
  it("reclaims when PID is missing or dead", () => {
    const probe: ProcessProbe = {
      isAlive: () => false,
      isOwnedWorker: () => true,
      signal: () => true,
      sleepMs: () => undefined,
    };
    expect(prepareOrphanEmbeddingWorkerForReclaim(null, probe)).toEqual({
      safeToReclaim: true,
      killed: false,
    });
    expect(prepareOrphanEmbeddingWorkerForReclaim(4242, probe)).toEqual({
      safeToReclaim: true,
      killed: false,
    });
  });

  it("kills owned live workers then reclaims when they exit", () => {
    let alive = true;
    const signals: NodeJS.Signals[] = [];
    const probe: ProcessProbe = {
      isAlive: () => alive,
      isOwnedWorker: () => true,
      signal: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") alive = false;
        return true;
      },
      sleepMs: () => undefined,
    };
    const result = prepareOrphanEmbeddingWorkerForReclaim(99, probe, 0);
    expect(result).toEqual({ safeToReclaim: true, killed: true });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("defers when a live process is not an owned worker", () => {
    const probe: ProcessProbe = {
      isAlive: () => true,
      isOwnedWorker: () => false,
      signal: () => {
        throw new Error("must not signal strangers");
      },
      sleepMs: () => undefined,
    };
    expect(prepareOrphanEmbeddingWorkerForReclaim(7, probe)).toEqual({
      safeToReclaim: false,
      killed: false,
    });
  });

  it("defers when owned worker stays alive after kill", () => {
    const probe: ProcessProbe = {
      isAlive: () => true,
      isOwnedWorker: () => true,
      signal: () => true,
      sleepMs: () => undefined,
    };
    expect(prepareOrphanEmbeddingWorkerForReclaim(7, probe, 0)).toEqual({
      safeToReclaim: false,
      killed: true,
    });
  });
});

describe("reclaimOrphanedEmbeddingJobRows", () => {
  it("requeues dead-PID running jobs and cancels cancel-requested", () => {
    const sqlite = memoryDbWithJobs();
    sqlite
      .prepare(
        `INSERT INTO embedding_jobs (target, state, processed, worker_pid)
         VALUES ('saves:local', 'running', 3, 111)`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO embedding_jobs (target, state, cancel_requested, worker_pid)
         VALUES ('likes:local', 'running', 1, 222)`,
      )
      .run();

    const probe: ProcessProbe = {
      isAlive: () => false,
      isOwnedWorker: () => true,
      signal: () => true,
      sleepMs: () => undefined,
    };

    const result = reclaimOrphanedEmbeddingJobRows(sqlite, {
      processProbe: probe,
      killGraceMs: 0,
    });
    expect(result).toMatchObject({
      resumed: 1,
      cancelled: 1,
      killed: 0,
      deferred: 0,
    });

    const states = sqlite
      .prepare(`SELECT state, worker_pid AS workerPid FROM embedding_jobs ORDER BY id`)
      .all() as Array<{ state: string; workerPid: number | null }>;
    expect(states[0]).toEqual({ state: "pending", workerPid: null });
    expect(states[1]).toEqual({ state: "cancelled", workerPid: null });
  });

  it("defers reclaim while an owned worker PID is still alive", () => {
    const sqlite = memoryDbWithJobs();
    sqlite
      .prepare(
        `INSERT INTO embedding_jobs (target, state, worker_pid)
         VALUES ('saves:local', 'running', 333)`,
      )
      .run();

    const probe: ProcessProbe = {
      isAlive: () => true,
      isOwnedWorker: () => true,
      signal: () => true,
      sleepMs: () => undefined,
    };

    const result = reclaimOrphanedEmbeddingJobRows(sqlite, {
      processProbe: probe,
      killGraceMs: 0,
    });
    expect(result).toMatchObject({
      resumed: 0,
      cancelled: 0,
      deferred: 1,
      killed: 1,
    });

    const row = sqlite
      .prepare(`SELECT state FROM embedding_jobs WHERE id = 1`)
      .get() as { state: string };
    expect(row.state).toBe("running");
  });
});
