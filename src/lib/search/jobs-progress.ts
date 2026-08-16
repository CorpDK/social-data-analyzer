/**
 * Progress write throttle for embedding jobs.
 * Extracted from jobs.ts so the 50-item / 1s policy is one place.
 */

export const JOB_PROGRESS_MIN_INTERVAL_MS = 1_000;
export const JOB_PROGRESS_EVERY_N = 50;

export type JobProgressThrottle = {
  lastWriteAt: number;
  lastProcessed: number;
};

/** Whether a rebuild progress tick should hit SQLite / SSE. */
export function shouldPersistRebuildProgress(
  progress: { phase: string; processed: number; total: number },
  state: JobProgressThrottle,
  force = false,
  now = Date.now(),
): boolean {
  return (
    force ||
    progress.phase === "done" ||
    progress.phase === "preparing" ||
    progress.phase === "fts" ||
    progress.processed === 0 ||
    (progress.total > 0 && progress.processed >= progress.total) ||
    progress.processed - state.lastProcessed >= JOB_PROGRESS_EVERY_N ||
    now - state.lastWriteAt >= JOB_PROGRESS_MIN_INTERVAL_MS
  );
}
