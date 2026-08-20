/**
 * Cheap search-index readiness checks and job scheduling.
 *
 * Browse / list / stats GETs must stay read-only: they never call
 * `ensureSearchIndexBackfill` (which can rebuild FTS + local vectors
 * synchronously for the whole library). Gaps are healed via embedding jobs
 * (`fts`, `local`, `likes-local`) with SSE progress on the Indexes UI.
 */
import { getStorage } from "../storage";
import { formatJobTarget, type SearchLibrary } from "./library";
import {
  enqueueFtsBackfillJob,
  ensureJobRunner,
  hasOpenEmbeddingJobForTarget,
  startReindexJob,
} from "./jobs";

export type SearchIndexGaps = {
  savesItems: number;
  likesItems: number;
  savesFtsGap: number;
  likesFtsGap: number;
  savesLocalGap: boolean;
  likesLocalGap: boolean;
  /** True when keyword or local vector coverage lags items. */
  degraded: boolean;
};

/** COUNT-only gap assessment — safe on any read path. */
export async function assessSearchIndexGaps(): Promise<SearchIndexGaps> {
  return (await getStorage()).search.assessSearchIndexGaps();
}

const globalForReadiness = globalThis as unknown as {
  __searchBackfillScheduleAttempted?: boolean;
};

export type ScheduleBackfillResult = {
  gaps: SearchIndexGaps;
  enqueued: string[];
  skipped: boolean;
};

/**
 * Enqueue FTS / local backfill jobs when coverage lags. Idempotent per process
 * (one attempt); open jobs are not duplicated. Call from Indexes "Heal gaps"
 * POST or documented startup — never from browse/list/stats or status GET.
 */
export async function scheduleSearchBackfillJobsIfNeeded(): Promise<ScheduleBackfillResult> {
  const gaps = await assessSearchIndexGaps();
  if (!gaps.degraded) {
    return { gaps, enqueued: [], skipped: false };
  }

  if (globalForReadiness.__searchBackfillScheduleAttempted) {
    return { gaps, enqueued: [], skipped: true };
  }
  globalForReadiness.__searchBackfillScheduleAttempted = true;

  await ensureJobRunner();
  const enqueued: string[] = [];

  if (gaps.savesFtsGap > 0 || gaps.likesFtsGap > 0) {
    if (!(await hasOpenEmbeddingJobForTarget("fts"))) {
      const job = await enqueueFtsBackfillJob();
      if (job) enqueued.push("fts");
    }
  }

  if (
    gaps.savesLocalGap &&
    !(await hasOpenEmbeddingJobForTarget(formatJobTarget("saves", "local")))
  ) {
    const result = await startReindexJob("local");
    if (result.ok) enqueued.push("local");
  }

  if (
    gaps.likesLocalGap &&
    !(await hasOpenEmbeddingJobForTarget(formatJobTarget("likes", "local")))
  ) {
    const result = await startReindexJob("likes-local");
    if (result.ok) enqueued.push("likes-local");
  }

  return { gaps, enqueued, skipped: false };
}

/** Test helper — reset the once-per-process schedule latch. */
export function resetSearchBackfillScheduleLatchForTests() {
  globalForReadiness.__searchBackfillScheduleAttempted = false;
}
