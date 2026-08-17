/**
 * Shared job-queue primitives for import and embedding runners.
 * Does not unify process models: embedding may use a child worker; import stays in-process.
 */

import fs from "node:fs";
import type Database from "better-sqlite3";
import {
  defaultProcessProbe,
  type ProcessProbe,
} from "./job-process";

/** Minimal pump state shared by both runners. */
export type PumpGuardState = {
  pumping: boolean;
};

/** In-memory cancel flags mirrored to `cancel_requested` rows. */
export type CancelFlagState = {
  cancelFlags: Map<number, boolean>;
};

/** Ownership fields used before reclaim / ensure. */
export type RunnerOwnershipState = PumpGuardState & {
  activeJobId: number | null;
  /** Present on embedding runner only (child worker handle). */
  activeChild?: unknown;
};

/**
 * True when this process currently owns work that must not be reclaimed
 * (active job id, in-flight pump, or embedding child worker).
 */
export function runnerOwnsWork(state: RunnerOwnershipState): boolean {
  return (
    state.activeJobId !== null ||
    state.pumping ||
    Boolean(state.activeChild)
  );
}

/**
 * Re-entrancy guard for queue pumps. Job writes publish SSE synchronously and
 * SSE snapshots call ensure*, so any queue write can re-enter on the same stack.
 */
export function withPumpGuard(state: PumpGuardState, fn: () => void): void {
  if (state.pumping) return;
  state.pumping = true;
  try {
    fn();
  } finally {
    state.pumping = false;
  }
}

/**
 * Cooperative cancel check: in-memory flag first, then DB `cancel_requested`.
 */
export function isJobCancelRequested(
  sqlite: Database.Database,
  table: "embedding_jobs" | "import_jobs",
  jobId: number,
  cancelFlags: Map<number, boolean>,
): boolean {
  if (cancelFlags.get(jobId)) return true;
  const row = sqlite
    .prepare(`SELECT cancel_requested AS c FROM ${table} WHERE id = ?`)
    .get(jobId) as { c: number } | undefined;
  return Boolean(row?.c);
}

export type EmbeddingReclaimResult = {
  cancelled: number;
  resumed: number;
  /** Stale worker PIDs we signalled before reclaim. */
  killed: number;
  /**
   * Running rows left untouched because a live owned worker could not be
   * stopped — reclaiming would risk a duplicate writer.
   */
  deferred: number;
};

const DEFAULT_RECLAIM_KILL_GRACE_MS = 200;

type RunningEmbeddingRow = {
  id: number;
  cancel_requested: number;
  worker_pid: number | null;
};

/**
 * Try to stop a stale embedding-worker PID before reclaiming its row.
 * Returns true when it is safe to reclaim (process gone / not our worker).
 * Returns false when a live owned worker remains — leave the row running.
 */
export function prepareOrphanEmbeddingWorkerForReclaim(
  workerPid: number | null | undefined,
  probe: ProcessProbe = defaultProcessProbe,
  graceMs = DEFAULT_RECLAIM_KILL_GRACE_MS,
): { safeToReclaim: boolean; killed: boolean } {
  if (workerPid == null || !Number.isInteger(workerPid) || workerPid <= 0) {
    return { safeToReclaim: true, killed: false };
  }

  if (!probe.isAlive(workerPid)) {
    return { safeToReclaim: true, killed: false };
  }

  // Live PID we cannot prove is ours — do not kill or reclaim (PID reuse risk).
  if (!probe.isOwnedWorker(workerPid)) {
    return { safeToReclaim: false, killed: false };
  }

  probe.signal(workerPid, "SIGTERM");
  (probe.sleepMs ?? (() => undefined))(graceMs);
  if (probe.isAlive(workerPid)) {
    probe.signal(workerPid, "SIGKILL");
    (probe.sleepMs ?? (() => undefined))(Math.min(100, graceMs));
  }

  if (probe.isAlive(workerPid)) {
    return { safeToReclaim: false, killed: true };
  }
  return { safeToReclaim: true, killed: true };
}

/**
 * Reclaim orphaned embedding `running` rows after restart/HMR.
 * Cancel-requested → cancelled; otherwise re-queue as pending for resume.
 * When `worker_pid` points at a live owned child, signal it first so we do not
 * spawn a duplicate writer beside an orphan. Caller must verify this process
 * does not own the job via runnerOwnsWork.
 */
export function reclaimOrphanedEmbeddingJobRows(
  sqlite: Database.Database,
  options?: {
    processProbe?: ProcessProbe;
    killGraceMs?: number;
  },
): EmbeddingReclaimResult {
  const probe = options?.processProbe ?? defaultProcessProbe;
  const graceMs = options?.killGraceMs ?? DEFAULT_RECLAIM_KILL_GRACE_MS;

  const hasWorkerPid = (
    sqlite.prepare(`PRAGMA table_info(embedding_jobs)`).all() as Array<{
      name: string;
    }>
  ).some((c) => c.name === "worker_pid");

  const orphaned = (
    hasWorkerPid
      ? sqlite
          .prepare(
            `SELECT id, cancel_requested, worker_pid
             FROM embedding_jobs WHERE state = 'running'`,
          )
          .all()
      : sqlite
          .prepare(
            `SELECT id, cancel_requested, NULL AS worker_pid
             FROM embedding_jobs WHERE state = 'running'`,
          )
          .all()
  ) as RunningEmbeddingRow[];

  let cancelled = 0;
  let resumed = 0;
  let killed = 0;
  let deferred = 0;

  for (const row of orphaned) {
    const prep = prepareOrphanEmbeddingWorkerForReclaim(
      row.worker_pid,
      probe,
      graceMs,
    );
    if (prep.killed) killed += 1;
    if (!prep.safeToReclaim) {
      deferred += 1;
      if (hasWorkerPid) {
        sqlite
          .prepare(
            `UPDATE embedding_jobs
             SET message = 'Waiting for stale embedding worker to exit before reclaim…',
                 updated_at = unixepoch()
             WHERE id = ? AND state = 'running'`,
          )
          .run(row.id);
      }
      continue;
    }

    const clearPid = hasWorkerPid ? ", worker_pid = NULL" : "";
    if (row.cancel_requested) {
      sqlite
        .prepare(
          `UPDATE embedding_jobs
           SET state = 'cancelled',
               message = 'Cancelled (interrupted while cancel was requested)',
               error = NULL${clearPid},
               finished_at = unixepoch(),
               updated_at = unixepoch()
           WHERE id = ? AND state = 'running'`,
        )
        .run(row.id);
      cancelled += 1;
    } else {
      sqlite
        .prepare(
          `UPDATE embedding_jobs
           SET state = 'pending',
               phase = 'queued'${clearPid},
               message = CASE
                 WHEN processed > 0 THEN 'Resuming after server restart…'
                 ELSE 'Re-queued after server restart'
               END,
               error = NULL,
               finished_at = NULL,
               updated_at = unixepoch()
           WHERE id = ? AND state = 'running'`,
        )
        .run(row.id);
      resumed += 1;
    }
  }

  return { cancelled, resumed, killed, deferred };
}

export type ImportReclaimResult = {
  requeued: number;
  failed: number;
};

/**
 * Reclaim orphaned import `running` rows: re-queue when spool exists, else fail.
 * Caller must verify this process does not own the job.
 */
export function reclaimOrphanedImportJobRows(
  sqlite: Database.Database,
  options?: {
    spoolExists?: (spoolPath: string) => boolean;
  },
): ImportReclaimResult {
  const spoolExists =
    options?.spoolExists ??
    ((spoolPath: string) =>
      typeof spoolPath === "string" &&
      spoolPath.length > 0 &&
      fs.existsSync(spoolPath));

  const orphaned = sqlite
    .prepare(`SELECT id, spool_path FROM import_jobs WHERE state = 'running'`)
    .all() as Array<{ id: number; spool_path: string }>;

  let requeued = 0;
  let failed = 0;

  for (const row of orphaned) {
    if (spoolExists(row.spool_path)) {
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
      requeued += 1;
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
      failed += 1;
    }
  }

  return { requeued, failed };
}
