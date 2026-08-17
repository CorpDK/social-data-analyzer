/**
 * Shared job-queue primitives for import and embedding runners.
 * Does not unify process models: embedding may use a child worker; import stays in-process.
 */

import fs from "node:fs";
import type Database from "better-sqlite3";

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
};

/**
 * Reclaim orphaned embedding `running` rows after restart/HMR.
 * Cancel-requested → cancelled; otherwise re-queue as pending for resume.
 * Caller must verify this process does not own the job.
 */
export function reclaimOrphanedEmbeddingJobRows(
  sqlite: Database.Database,
): EmbeddingReclaimResult {
  const cancelled = sqlite
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

  const resumed = sqlite
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

  return {
    cancelled: cancelled.changes,
    resumed: resumed.changes,
  };
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
