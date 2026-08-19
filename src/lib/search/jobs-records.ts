/**
 * Embedding job row mapping and read/query helpers.
 * Extracted from jobs.ts; queue pump / spawn / cancel stay there.
 */
import { getSqlite } from "../db";
import { type EmbeddingProvider } from "./embeddings";
import {
  formatJobTarget,
  parseLibraryJobTarget,
} from "./library";
import { jobProgressPercent } from "../job-queue";

/**
 * API accept / persisted job target.
 * Saves: `local` | `ollama` | `openai` | `voyage`
 * Likes: `likes-local` | `likes-ollama` | `likes-openai` | `likes-voyage`
 * Also: `fts` | legacy `all-configured` (never newly enqueued).
 */
export type EmbeddingJobTarget = string;

export type EmbeddingJobState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type EmbeddingJobPhase =
  | "queued"
  | "preparing"
  | "fts"
  | "embedding"
  | "storing"
  | "done";

export type EmbeddingJobRecord = {
  id: number;
  target: EmbeddingJobTarget;
  state: EmbeddingJobState;
  phase: EmbeddingJobPhase;
  processed: number;
  total: number;
  percent: number;
  currentProvider: EmbeddingProvider | null;
  error: string | null;
  message: string | null;
  cancelRequested: boolean;
  startedAt: number;
  finishedAt: number | null;
  updatedAt: number;
};

function mapJobRow(row: {
  id: number;
  target: string;
  state: string;
  phase: string;
  processed: number;
  total: number;
  current_provider: string | null;
  error: string | null;
  message: string | null;
  cancel_requested: number;
  started_at: number;
  finished_at: number | null;
  updated_at: number;
}): EmbeddingJobRecord {
  const total = row.total;
  const processed = row.processed;
  const percent = jobProgressPercent(
    processed,
    total,
    row.state === "completed",
  );

  return {
    id: row.id,
    target: row.target,
    state: row.state as EmbeddingJobState,
    phase: row.phase as EmbeddingJobPhase,
    processed,
    total,
    percent,
    currentProvider: (row.current_provider as EmbeddingProvider | null) ?? null,
    error: row.error,
    message: row.message,
    cancelRequested: Boolean(row.cancel_requested),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

const JOB_SELECT = `SELECT id, target, state, phase, processed, total, current_provider,
              error, message, cancel_requested, started_at, finished_at, updated_at
       FROM embedding_jobs`;

export function parseReindexTarget(
  value: unknown,
): EmbeddingJobTarget | null {
  if (typeof value !== "string") return null;
  const parsed = parseLibraryJobTarget(value);
  if (!parsed) return null;
  if (parsed.kind === "all-configured") return "all-configured";
  if (parsed.kind === "fts") return "fts";
  return formatJobTarget(parsed.library, parsed.provider);
}

export function getEmbeddingJob(id: number): EmbeddingJobRecord | null {
  const row = getSqlite()
    .prepare(`${JOB_SELECT} WHERE id = ?`)
    .get(id) as Parameters<typeof mapJobRow>[0] | undefined;
  return row ? mapJobRow(row) : null;
}

export function getLatestEmbeddingJob(): EmbeddingJobRecord | null {
  const row = getSqlite()
    .prepare(`${JOB_SELECT} ORDER BY id DESC LIMIT 1`)
    .get() as Parameters<typeof mapJobRow>[0] | undefined;
  return row ? mapJobRow(row) : null;
}

export function getLatestFinishedEmbeddingJob(): EmbeddingJobRecord | null {
  const row = getSqlite()
    .prepare(
      `${JOB_SELECT}
       WHERE state IN ('completed', 'failed', 'cancelled')
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get() as Parameters<typeof mapJobRow>[0] | undefined;
  return row ? mapJobRow(row) : null;
}

export function getActiveEmbeddingJob(): EmbeddingJobRecord | null {
  const row = getSqlite()
    .prepare(
      `${JOB_SELECT}
       WHERE state = 'running'
       ORDER BY id ASC
       LIMIT 1`,
    )
    .get() as Parameters<typeof mapJobRow>[0] | undefined;
  return row ? mapJobRow(row) : null;
}

export function getPendingEmbeddingJobs(): EmbeddingJobRecord[] {
  const rows = getSqlite()
    .prepare(
      `${JOB_SELECT}
       WHERE state = 'pending'
       ORDER BY id ASC`,
    )
    .all() as Parameters<typeof mapJobRow>[0][];
  return rows.map(mapJobRow);
}

/** Recent terminal jobs (completed / failed / cancelled), newest first. */
export function getRecentEmbeddingJobs(limit = 8): EmbeddingJobRecord[] {
  const rows = getSqlite()
    .prepare(
      `${JOB_SELECT}
       WHERE state IN ('completed', 'failed', 'cancelled')
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(limit) as Parameters<typeof mapJobRow>[0][];
  return rows.map(mapJobRow);
}

const DEFAULT_JOB_LIST_LIMIT = 50;
const MAX_JOB_LIST_LIMIT = 100;

/** All embedding jobs newest-first (running/pending mixed with finished by id). */
export function listEmbeddingJobs(options?: {
  limit?: number;
  offset?: number;
}): { jobs: EmbeddingJobRecord[]; total: number; limit: number; offset: number } {
  const limit = Math.min(
    Math.max(1, Math.floor(options?.limit ?? DEFAULT_JOB_LIST_LIMIT)),
    MAX_JOB_LIST_LIMIT,
  );
  const offset = Math.max(0, Math.floor(options?.offset ?? 0));
  const sqlite = getSqlite();
  const total = (
    sqlite.prepare(`SELECT count(*) AS c FROM embedding_jobs`).get() as {
      c: number;
    }
  ).c;
  const rows = sqlite
    .prepare(`${JOB_SELECT} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(limit, offset) as Parameters<typeof mapJobRow>[0][];
  return { jobs: rows.map(mapJobRow), total, limit, offset };
}

/** Active job if any, else the latest finished job (for status display). */
export function getDisplayEmbeddingJob(): EmbeddingJobRecord | null {
  return getActiveEmbeddingJob() ?? getLatestFinishedEmbeddingJob();
}

export function getOpenJobForTarget(
  target: EmbeddingJobTarget,
): EmbeddingJobRecord | null {
  const row = getSqlite()
    .prepare(
      `${JOB_SELECT}
       WHERE target = ?
         AND state IN ('pending', 'running')
       ORDER BY id ASC
       LIMIT 1`,
    )
    .get(target) as Parameters<typeof mapJobRow>[0] | undefined;
  return row ? mapJobRow(row) : null;
}

/** Whether a pending/running job already covers this concrete target. */
export function hasOpenEmbeddingJobForTarget(
  target: EmbeddingJobTarget,
): boolean {
  return getOpenJobForTarget(target) != null;
}
