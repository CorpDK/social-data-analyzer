/**
 * Progress write throttle for embedding jobs.
 * Thin wrapper over the shared progress-throttle helper.
 */

import {
  createProgressThrottleState,
  markProgressPublished,
  REBUILD_FORCE_PHASES,
  shouldPublishProgress,
  type ProgressThrottleState,
  PROGRESS_THROTTLE_EVERY_N,
  PROGRESS_THROTTLE_MIN_MS,
} from "../progress-throttle";

export const JOB_PROGRESS_MIN_INTERVAL_MS = PROGRESS_THROTTLE_MIN_MS;
export const JOB_PROGRESS_EVERY_N = PROGRESS_THROTTLE_EVERY_N;

export type JobProgressThrottle = ProgressThrottleState;

export {
  createProgressThrottleState,
  markProgressPublished,
  shouldPublishProgress,
};

/** Whether a rebuild progress tick should hit SQLite / SSE. */
export function shouldPersistRebuildProgress(
  progress: { phase: string; processed: number; total: number },
  state: JobProgressThrottle,
  force = false,
  now = Date.now(),
): boolean {
  return shouldPublishProgress(progress, state, {
    force,
    forcePhases: REBUILD_FORCE_PHASES,
    now,
  });
}
