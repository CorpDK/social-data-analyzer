/**
 * Optional SQLite housekeeping for long-lived local DBs: WAL checkpoint and
 * VACUUM. Refuses while import/reindex jobs are active so we never race writers.
 */
import type Database from "better-sqlite3";
import { getSqlite } from "../db";
import { assertLibraryIdle, LibraryBusyError } from "./library-busy";

export { LibraryBusyError };
export type { LibraryBusyState } from "./library-busy";

export type DbMaintenanceAction = "checkpoint" | "vacuum";

export type WalCheckpointResult = {
  busy: number;
  log: number;
  checkpointed: number;
};

export type DbMaintenanceResult = {
  ok: true;
  action: DbMaintenanceAction;
  /** wal_checkpoint(TRUNCATE) triple when action is checkpoint. */
  walCheckpoint?: WalCheckpointResult;
  /** Wall time for VACUUM (ms). */
  vacuumMs?: number;
  pageCount: number;
  freelistCount: number;
  pageSize: number;
};

function readDbStats(sqlite: Database.Database): {
  pageCount: number;
  freelistCount: number;
  pageSize: number;
} {
  const pageCount = Number(sqlite.pragma("page_count", { simple: true }));
  const freelistCount = Number(sqlite.pragma("freelist_count", { simple: true }));
  const pageSize = Number(sqlite.pragma("page_size", { simple: true }));
  return { pageCount, freelistCount, pageSize };
}

function parseWalCheckpoint(raw: unknown): WalCheckpointResult {
  // better-sqlite3 returns [{ busy, log, checkpointed }] for this pragma.
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (!row || typeof row !== "object") {
    return { busy: 0, log: 0, checkpointed: 0 };
  }
  const record = row as Record<string, unknown>;
  return {
    busy: Number(record.busy ?? 0),
    log: Number(record.log ?? 0),
    checkpointed: Number(record.checkpointed ?? 0),
  };
}

export function parseDbMaintenanceAction(
  value: unknown,
): DbMaintenanceAction | null {
  if (value === "checkpoint" || value === "vacuum") return value;
  return null;
}

/**
 * Run WAL checkpoint (TRUNCATE) or full VACUUM while the library is idle.
 * Local single-user only — VACUUM can take noticeable time on large libraries.
 */
export function runDbMaintenance(
  action: DbMaintenanceAction,
  sqlite: Database.Database = getSqlite(),
): DbMaintenanceResult {
  const operation =
    action === "vacuum" ? "run VACUUM" : "run WAL checkpoint";
  assertLibraryIdle(sqlite, operation);

  if (action === "checkpoint") {
    const raw = sqlite.pragma("wal_checkpoint(TRUNCATE)");
    const walCheckpoint = parseWalCheckpoint(raw);
    const stats = readDbStats(sqlite);
    return {
      ok: true,
      action,
      walCheckpoint,
      ...stats,
    };
  }

  const started = Date.now();
  sqlite.exec("VACUUM");
  const vacuumMs = Date.now() - started;
  const stats = readDbStats(sqlite);
  return {
    ok: true,
    action,
    vacuumMs,
    ...stats,
  };
}
