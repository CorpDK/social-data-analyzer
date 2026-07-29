import { getSqlite } from "../db";
import {
  isEmbeddingProvider,
  type EmbeddingProvider,
} from "./embeddings";
import {
  RebuildCancelledError,
  rebuildConfiguredIndexes,
  rebuildProviderIndex,
  type RebuildProgress,
} from "./sync";
import { configuredProviders, isProviderConfigured } from "./providers";

/** API accept target; persisted jobs use a concrete provider (never all-configured). */
export type EmbeddingJobTarget = EmbeddingProvider | "all-configured";

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

type JobRunnerState = {
  activeJobId: number | null;
  cancelFlags: Map<number, boolean>;
};

const globalForJobs = globalThis as unknown as {
  embeddingJobRunner?: JobRunnerState;
};

function runner(): JobRunnerState {
  if (!globalForJobs.embeddingJobRunner) {
    globalForJobs.embeddingJobRunner = {
      activeJobId: null,
      cancelFlags: new Map(),
    };
  }
  return globalForJobs.embeddingJobRunner;
}

/** Mark DB "running" rows as failed when this process is not actually running them. */
function reclaimOrphanedJobs() {
  const state = runner();
  if (state.activeJobId !== null) return;
  getSqlite()
    .prepare(
      `UPDATE embedding_jobs
       SET state = 'failed',
           error = COALESCE(error, 'Interrupted by server restart'),
           message = 'Job interrupted by server restart',
           finished_at = unixepoch(),
           updated_at = unixepoch()
       WHERE state = 'running'`,
    )
    .run();
}

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
  const percent =
    total <= 0
      ? row.state === "completed"
        ? 100
        : 0
      : Math.min(100, Math.round((processed / total) * 1000) / 10);

  return {
    id: row.id,
    target: row.target as EmbeddingJobTarget,
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
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "all-configured") return "all-configured";
  if (isEmbeddingProvider(trimmed)) return trimmed;
  return null;
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

function getOpenJobForProvider(
  provider: EmbeddingProvider,
): EmbeddingJobRecord | null {
  const row = getSqlite()
    .prepare(
      `${JOB_SELECT}
       WHERE target = ?
         AND state IN ('pending', 'running')
       ORDER BY id ASC
       LIMIT 1`,
    )
    .get(provider) as Parameters<typeof mapJobRow>[0] | undefined;
  return row ? mapJobRow(row) : null;
}

function updateJob(
  id: number,
  patch: {
    state?: EmbeddingJobState;
    phase?: EmbeddingJobPhase;
    processed?: number;
    total?: number;
    currentProvider?: EmbeddingProvider | null;
    error?: string | null;
    message?: string | null;
    finished?: boolean;
  },
) {
  const sets: string[] = ["updated_at = unixepoch()"];
  const values: unknown[] = [];

  if (patch.state !== undefined) {
    sets.push("state = ?");
    values.push(patch.state);
  }
  if (patch.phase !== undefined) {
    sets.push("phase = ?");
    values.push(patch.phase);
  }
  if (patch.processed !== undefined) {
    sets.push("processed = ?");
    values.push(patch.processed);
  }
  if (patch.total !== undefined) {
    sets.push("total = ?");
    values.push(patch.total);
  }
  if (patch.currentProvider !== undefined) {
    sets.push("current_provider = ?");
    values.push(patch.currentProvider);
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    values.push(patch.error);
  }
  if (patch.message !== undefined) {
    sets.push("message = ?");
    values.push(patch.message);
  }
  if (patch.finished) {
    sets.push("finished_at = unixepoch()");
  }

  values.push(id);
  getSqlite()
    .prepare(`UPDATE embedding_jobs SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values);
}

function progressToPhase(phase: RebuildProgress["phase"]): EmbeddingJobPhase {
  return phase;
}

async function applyProgress(jobId: number, progress: RebuildProgress) {
  updateJob(jobId, {
    phase: progressToPhase(progress.phase),
    processed: progress.processed,
    total: progress.total,
    currentProvider: progress.currentProvider ?? null,
    message: progress.message ?? null,
  });
}

function shouldCancel(jobId: number): boolean {
  const state = runner();
  if (state.cancelFlags.get(jobId)) return true;
  const row = getSqlite()
    .prepare(`SELECT cancel_requested AS c FROM embedding_jobs WHERE id = ?`)
    .get(jobId) as { c: number } | undefined;
  return Boolean(row?.c);
}

function insertPendingJob(target: EmbeddingProvider): EmbeddingJobRecord {
  const sqlite = getSqlite();
  const totalItems = (
    sqlite.prepare(`SELECT count(*) AS c FROM saved_items`).get() as {
      c: number;
    }
  ).c;

  const info = sqlite
    .prepare(
      `INSERT INTO embedding_jobs(
        target, state, phase, processed, total, current_provider, message
      ) VALUES (?, 'pending', 'queued', 0, ?, NULL, ?)`,
    )
    .run(target, totalItems, `Queued rebuild for ${target}`);

  const job = getEmbeddingJob(Number(info.lastInsertRowid));
  if (!job) throw new Error("Failed to create embedding job");
  return job;
}

async function executeJob(jobId: number, target: EmbeddingJobTarget) {
  const state = runner();
  try {
    const onProgress = (progress: RebuildProgress) =>
      applyProgress(jobId, progress);
    const cancel = () => shouldCancel(jobId);

    // Legacy rows may still use all-configured; new code never creates them.
    if (target === "all-configured") {
      const result = await rebuildConfiguredIndexes({
        onProgress,
        shouldCancel: cancel,
      });
      updateJob(jobId, {
        state: "completed",
        phase: "done",
        processed: result.items,
        total: result.items,
        currentProvider: null,
        message: `Rebuilt ${result.providers.join(", ")} (${result.items} items)`,
        finished: true,
      });
    } else {
      const result = await rebuildProviderIndex(target, {
        onProgress,
        shouldCancel: cancel,
      });
      updateJob(jobId, {
        state: "completed",
        phase: "done",
        processed: result.items,
        total: result.items,
        currentProvider: target,
        message: `Rebuilt ${target} (${result.items} items)`,
        finished: true,
      });
    }
  } catch (error) {
    if (error instanceof RebuildCancelledError || shouldCancel(jobId)) {
      updateJob(jobId, {
        state: "cancelled",
        phase: "done",
        message: "Reindex cancelled",
        error: null,
        finished: true,
      });
    } else {
      updateJob(jobId, {
        state: "failed",
        message: "Reindex failed",
        error: error instanceof Error ? error.message : "unknown error",
        finished: true,
      });
    }
  } finally {
    state.cancelFlags.delete(jobId);
    if (state.activeJobId === jobId) state.activeJobId = null;
    // Start the next pending job (if any) after this one settles.
    pumpQueue();
  }
}

/** Promote the oldest pending job to running when the runner is idle. */
function pumpQueue() {
  const state = runner();
  if (state.activeJobId !== null) return;

  // DB may still say "running" after a crash — reclaim before starting another.
  const dbActive = getActiveEmbeddingJob();
  if (dbActive) {
    reclaimOrphanedJobs();
  }

  const next = getPendingEmbeddingJobs()[0];
  if (!next) return;

  updateJob(next.id, {
    state: "running",
    phase: "queued",
    message: `Starting rebuild for ${next.target}`,
  });

  state.activeJobId = next.id;
  state.cancelFlags.set(next.id, false);
  void executeJob(next.id, next.target);
}

/**
 * Reclaim orphaned running rows and resume the pending queue after restart/HMR.
 * Safe to call from status polls.
 */
export function ensureJobRunner() {
  const state = runner();
  if (state.activeJobId !== null) return;
  reclaimOrphanedJobs();
  pumpQueue();
}

export type StartReindexResult =
  | { ok: true; job: EmbeddingJobRecord; jobs: EmbeddingJobRecord[] }
  | {
      ok: false;
      error: string;
      status: number;
      job?: EmbeddingJobRecord;
      jobs?: EmbeddingJobRecord[];
    };

export function startReindexJob(target: EmbeddingJobTarget): StartReindexResult {
  ensureJobRunner();

  if (target === "all-configured") {
    const providers = configuredProviders();
    if (providers.length === 0) {
      return {
        ok: false,
        error: "No providers are enabled (and credentialed where required)",
        status: 400,
      };
    }

    const enqueued: EmbeddingJobRecord[] = [];
    const alreadyOpen: EmbeddingJobRecord[] = [];

    for (const provider of providers) {
      const open = getOpenJobForProvider(provider);
      if (open) {
        alreadyOpen.push(open);
        continue;
      }
      enqueued.push(insertPendingJob(provider));
    }

    if (enqueued.length === 0) {
      return {
        ok: false,
        error:
          "All configured providers already have a pending or running reindex job",
        status: 409,
        job: getActiveEmbeddingJob() ?? alreadyOpen[0],
        jobs: alreadyOpen,
      };
    }

    pumpQueue();

    const jobs = [...enqueued];
    const active = getActiveEmbeddingJob();
    const job =
      active && jobs.some((j) => j.id === active.id)
        ? active
        : (getEmbeddingJob(enqueued[0]!.id) ?? enqueued[0]!);

    return {
      ok: true,
      job,
      jobs: jobs.map((j) => getEmbeddingJob(j.id) ?? j),
    };
  }

  if (!isProviderConfigured(target)) {
    return {
      ok: false,
      error: `${target} is not enabled — turn it on in Settings (and add credentials if needed)`,
      status: 400,
    };
  }

  const open = getOpenJobForProvider(target);
  if (open) {
    return {
      ok: false,
      error:
        open.state === "running"
          ? `A reindex job for ${target} is already running.`
          : `A reindex job for ${target} is already queued.`,
      status: 409,
      job: open,
      jobs: [open],
    };
  }

  const created = insertPendingJob(target);
  pumpQueue();
  const job = getEmbeddingJob(created.id) ?? created;
  return { ok: true, job, jobs: [job] };
}

export type CancelReindexResult =
  | { ok: true; job: EmbeddingJobRecord }
  | { ok: false; error: string; status: number; job?: EmbeddingJobRecord };

/**
 * Cancel the active (running) job only. Pending queued jobs remain and will
 * start after the active job settles (cancelled / completed / failed).
 */
export function cancelReindexJob(jobId?: number): CancelReindexResult {
  ensureJobRunner();

  const active = jobId ? getEmbeddingJob(jobId) : getActiveEmbeddingJob();
  if (!active || active.state !== "running") {
    return {
      ok: false,
      error: "No running reindex job to cancel",
      status: 404,
      job: active ?? undefined,
    };
  }

  getSqlite()
    .prepare(
      `UPDATE embedding_jobs
       SET cancel_requested = 1,
           message = 'Cancel requested…',
           updated_at = unixepoch()
       WHERE id = ?`,
    )
    .run(active.id);

  runner().cancelFlags.set(active.id, true);

  const job = getEmbeddingJob(active.id);
  if (!job) {
    return { ok: false, error: "Job disappeared", status: 500 };
  }
  return { ok: true, job };
}

/** Test helper: wait until the queue is idle (no running or pending jobs). */
export async function waitForIdleJob(
  timeoutMs = 30_000,
): Promise<EmbeddingJobRecord | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    ensureJobRunner();
    const active = getActiveEmbeddingJob();
    const pending = getPendingEmbeddingJobs();
    if (!active && pending.length === 0) return getLatestEmbeddingJob();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for embedding job queue to finish");
}
