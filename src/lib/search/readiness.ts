/**
 * Cheap search-index readiness checks and job scheduling.
 *
 * Browse / list / stats GETs must stay read-only: they never call
 * `ensureSearchIndexBackfill` (which can rebuild FTS + local vectors
 * synchronously for the whole library). Gaps are healed via embedding jobs
 * (`fts`, `local`, `likes-local`) with SSE progress on the Indexes UI.
 */
import { getSqlite } from "../db";
import { ftsCount } from "./sync-fts";
import { vecCount, vectorIndexMatchesConfig } from "./sync-vec-store";
import { localEmbeddingConfig } from "./embeddings";
import { formatJobTarget, type SearchLibrary } from "./library";
import { isProviderConfigured } from "./providers";
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

function itemCount(library: SearchLibrary): number {
  const table = library === "saves" ? "saved_items" : "liked_items";
  return (
    getSqlite().prepare(`SELECT count(*) AS c FROM ${table}`).get() as {
      c: number;
    }
  ).c;
}

function localVectorNeedsBackfill(library: SearchLibrary): boolean {
  if (!isProviderConfigured("local", library)) return false;
  const total = itemCount(library);
  if (total <= 0) return false;
  const sqlite = getSqlite();
  const embedded = vecCount(library, "local", sqlite);
  if (embedded < total) return true;
  return !vectorIndexMatchesConfig(
    library,
    "local",
    localEmbeddingConfig(),
    sqlite,
  );
}

/** COUNT-only gap assessment — safe on any read path. */
export function assessSearchIndexGaps(): SearchIndexGaps {
  const savesItems = itemCount("saves");
  const likesItems = itemCount("likes");
  const savesFts = ftsCount("saves");
  const likesFts = ftsCount("likes");
  const savesFtsGap = Math.max(0, savesItems - savesFts);
  const likesFtsGap = Math.max(0, likesItems - likesFts);
  const savesLocalGap = localVectorNeedsBackfill("saves");
  const likesLocalGap = localVectorNeedsBackfill("likes");
  return {
    savesItems,
    likesItems,
    savesFtsGap,
    likesFtsGap,
    savesLocalGap,
    likesLocalGap,
    degraded:
      savesFtsGap > 0 ||
      likesFtsGap > 0 ||
      savesLocalGap ||
      likesLocalGap,
  };
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
 * (one attempt); open jobs are not duplicated. Call from Indexes/status or
 * explicit startup — never from browse/list/stats.
 */
export function scheduleSearchBackfillJobsIfNeeded(): ScheduleBackfillResult {
  const gaps = assessSearchIndexGaps();
  if (!gaps.degraded) {
    return { gaps, enqueued: [], skipped: false };
  }

  if (globalForReadiness.__searchBackfillScheduleAttempted) {
    return { gaps, enqueued: [], skipped: true };
  }
  globalForReadiness.__searchBackfillScheduleAttempted = true;

  ensureJobRunner();
  const enqueued: string[] = [];

  if (gaps.savesFtsGap > 0 || gaps.likesFtsGap > 0) {
    if (!hasOpenEmbeddingJobForTarget("fts")) {
      const job = enqueueFtsBackfillJob();
      if (job) enqueued.push("fts");
    }
  }

  if (gaps.savesLocalGap && !hasOpenEmbeddingJobForTarget(formatJobTarget("saves", "local"))) {
    const result = startReindexJob("local");
    if (result.ok) enqueued.push("local");
  }

  if (
    gaps.likesLocalGap &&
    !hasOpenEmbeddingJobForTarget(formatJobTarget("likes", "local"))
  ) {
    const result = startReindexJob("likes-local");
    if (result.ok) enqueued.push("likes-local");
  }

  return { gaps, enqueued, skipped: false };
}

/** Test helper — reset the once-per-process schedule latch. */
export function resetSearchBackfillScheduleLatchForTests() {
  globalForReadiness.__searchBackfillScheduleAttempted = false;
}
