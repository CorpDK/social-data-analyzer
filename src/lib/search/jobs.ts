import type { ChildProcess } from "node:child_process";
import { getSqlite } from "../db";
import {
  type EmbeddingProvider,
} from "./embeddings";
import {
  formatJobTarget,
  parseLibraryJobTarget,
  SEARCH_LIBRARIES,
  type SearchLibrary,
} from "./library";
import {
  assessReindexMemory,
  logReindexMemoryWarning,
} from "./memory";
import {
  markProgressPublished,
  shouldPersistRebuildProgress,
  type JobProgressThrottle,
} from "./jobs-progress";
import {
  scheduleEmbeddingChildTermination,
  spawnEmbeddingWorker,
} from "./jobs-spawn";
import {
  RebuildCancelledError,
  rebuildConfiguredIndexes,
  rebuildProviderIndex,
  type RebuildProgress,
} from "./sync";
import { configuredProviders, isProviderConfigured } from "./providers";
import {
  isJobCancelRequested,
  reclaimOrphanedEmbeddingJobRows,
  runnerOwnsWork,
  withPumpGuard,
} from "../job-queue";
import { SEARCH_STATUS_CHANNEL, publishJobEvent } from "../sse";
import {
  classifyWorkerExit,
  MAX_EMBEDDING_WORKER_ATTEMPTS,
  PermanentEmbeddingJobError,
  planWorkerRetry,
  type WorkerExit,
} from "./worker-policy";

export {
  classifyWorkerExit,
  EMBEDDING_WORKER_FAST_FAILURE_MS,
  EMBEDDING_WORKER_PERMANENT_EXIT_CODE,
  EMBEDDING_WORKER_RETRY_BACKOFF_MS,
  embeddingWorkerRetryDelayMs,
  isPermanentEmbeddingJobError,
  MAX_EMBEDDING_WORKER_ATTEMPTS,
  PermanentEmbeddingJobError,
  planWorkerRetry,
} from "./worker-policy";
export type { WorkerExit, WorkerExitClassification } from "./worker-policy";

/**
 * API accept target. Persisted jobs use a concrete target:
 * - Saves: `local` | `ollama` | `openai` | `voyage`
 * - Likes: `likes-local` | `likes-ollama` | `likes-openai` | `likes-voyage`
 * Never stores `all-configured`.
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

type JobRunnerState = {
  activeJobId: number | null;
  cancelFlags: Map<number, boolean>;
  activeChild: ChildProcess | null;
  /** Job that owns `activeChild`, so a later job cannot clear another's handle. */
  activeChildJobId: number | null;
  /**
   * Re-entrancy guard. `updateJob` publishes SSE events synchronously, and SSE
   * snapshots call `ensureJobRunner()`, so any queue write can re-enter the
   * queue on the same stack.
   */
  pumping: boolean;
  /** Worker spawn attempts per job id; cleared when the job settles. */
  attempts: Map<number, number>;
  /** Earliest ms timestamp a pending job may start again (retry backoff). */
  deferredUntil: Map<number, number>;
  retryTimers: Map<number, ReturnType<typeof setTimeout>>;
  /** Last failure logged per job, so a repeating failure cannot spam stacks. */
  loggedFailures: Map<number, { message: string; count: number }>;
  shutdownHooked: boolean;
};

const globalForJobs = globalThis as unknown as {
  embeddingJobRunner?: JobRunnerState;
};

function runner(): JobRunnerState {
  const state = globalForJobs.embeddingJobRunner;
  if (!state) {
    const fresh: JobRunnerState = {
      activeJobId: null,
      cancelFlags: new Map(),
      activeChild: null,
      activeChildJobId: null,
      pumping: false,
      attempts: new Map(),
      deferredUntil: new Map(),
      retryTimers: new Map(),
      loggedFailures: new Map(),
      shutdownHooked: false,
    };
    globalForJobs.embeddingJobRunner = fresh;
    return fresh;
  }

  // HMR keeps the object on globalThis; older shapes miss the newer fields.
  const legacy = state as Partial<JobRunnerState>;
  if (legacy.activeChild === undefined) state.activeChild = null;
  if (legacy.activeChildJobId === undefined) state.activeChildJobId = null;
  if (legacy.pumping === undefined) state.pumping = false;
  if (!legacy.attempts) state.attempts = new Map();
  if (!legacy.deferredUntil) state.deferredUntil = new Map();
  if (!legacy.retryTimers) state.retryTimers = new Map();
  if (!legacy.loggedFailures) state.loggedFailures = new Map();
  if (legacy.shutdownHooked === undefined) state.shutdownHooked = false;
  return state;
}

function isTerminalJobState(state: EmbeddingJobState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

/**
 * Prefer a child process for rebuilds so Ollama/API + chunk writes do not
 * freeze the Next.js event loop as badly. Tests and the worker itself use
 * inline mode (`EMBEDDING_WORKER_INLINE=1`).
 *
 * SQLite: WAL + busy_timeout; the child is the writer for vectors during the
 * job, while the parent only updates cancel flags / reads status.
 */
function preferChildEmbeddingWorker(): boolean {
  if (process.env.EMBEDDING_WORKER_INLINE === "1") return false;
  if (process.env.EMBEDDING_WORKER_CHILD === "1") return false;
  // test-parse uses the memory keyring + mocked fetch in-process
  if (process.env.INSTAGRAM_SAVES_KEYRING === "memory") return false;
  return true;
}

/**
 * Reclaim orphaned "running" rows after restart/HMR.
 * Interrupted jobs with progress are re-queued as pending so the next pump
 * resumes (skip already-embedded ids) instead of wiping the vec table.
 */
function reclaimOrphanedJobs() {
  const state = runner();
  // Never re-queue a row this process still owns: the child worker's row is
  // `running` while it works, and re-queuing it here would let the queue spawn
  // a second worker for the same job.
  if (runnerOwnsWork(state)) return;
  reclaimOrphanedJobRows();
}

/** Caller must have verified that no job is owned by this process. */
function reclaimOrphanedJobRows() {
  const result = reclaimOrphanedEmbeddingJobRows(getSqlite());
  if (result.cancelled > 0 || result.resumed > 0) {
    publishJobEvent(SEARCH_STATUS_CHANNEL, true);
  }
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

function getOpenJobForTarget(
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

const jobProgressThrottle = new Map<number, JobProgressThrottle>();

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

  const immediate = Boolean(
    patch.state !== undefined || patch.finished === true,
  );
  publishJobEvent(SEARCH_STATUS_CHANNEL, immediate);
}

function progressToPhase(phase: RebuildProgress["phase"]): EmbeddingJobPhase {
  return phase;
}

/**
 * Persist job progress at most ~1 Hz or every N items.
 * Always writes on preparing/fts/done and when force=true (complete/fail).
 */
async function applyProgress(
  jobId: number,
  progress: RebuildProgress,
  force = false,
) {
  const state = jobProgressThrottle.get(jobId) ?? {
    lastWriteAt: 0,
    lastProcessed: -1,
  };
  const now = Date.now();
  if (!shouldPersistRebuildProgress(progress, state, force, now)) return;

  markProgressPublished(state, progress, now);
  jobProgressThrottle.set(jobId, state);

  updateJob(jobId, {
    phase: progressToPhase(progress.phase),
    processed: progress.processed,
    total: progress.total,
    currentProvider: progress.currentProvider ?? null,
    message: progress.message ?? null,
  });
}

function clearJobProgressThrottle(jobId: number) {
  jobProgressThrottle.delete(jobId);
}

function shouldCancel(jobId: number): boolean {
  return isJobCancelRequested(
    getSqlite(),
    "embedding_jobs",
    jobId,
    runner().cancelFlags,
  );
}

function insertPendingJob(
  library: SearchLibrary,
  provider: EmbeddingProvider,
): EmbeddingJobRecord {
  const sqlite = getSqlite();
  const table = library === "saves" ? "saved_items" : "liked_items";
  const totalItems = (
    sqlite.prepare(`SELECT count(*) AS c FROM ${table}`).get() as {
      c: number;
    }
  ).c;
  const target = formatJobTarget(library, provider);

  const info = sqlite
    .prepare(
      `INSERT INTO embedding_jobs(
        target, state, phase, processed, total, current_provider, message
      ) VALUES (?, 'pending', 'queued', 0, ?, NULL, ?)`,
    )
    .run(target, totalItems, `Queued rebuild for ${target}`);

  const job = getEmbeddingJob(Number(info.lastInsertRowid));
  if (!job) throw new Error("Failed to create embedding job");
  publishJobEvent(SEARCH_STATUS_CHANNEL, true);
  return job;
}

function libraryItemCount(library: SearchLibrary): number {
  const table = library === "saves" ? "saved_items" : "liked_items";
  return (
    getSqlite().prepare(`SELECT count(*) AS c FROM ${table}`).get() as {
      c: number;
    }
  ).c;
}

/**
 * Hard refuse any provider reindex when free RAM is critically low, or when
 * a large library is below that provider's MemAvailable floor. Soft warnings
 * are logged separately.
 */
function refuseReindexIfNeeded(
  library: SearchLibrary,
  provider: EmbeddingProvider,
): string | null {
  const assessment = assessReindexMemory(
    library,
    provider,
    libraryItemCount(library),
  );
  logReindexMemoryWarning(assessment);
  if (assessment.refuse) return assessment.refuseReason;
  return null;
}


async function runEmbeddingJobInline(
  jobId: number,
  target: EmbeddingJobTarget,
) {
  const onProgress = (progress: RebuildProgress) =>
    applyProgress(jobId, progress);
  const cancel = () => shouldCancel(jobId);
  const job = getEmbeddingJob(jobId);
  const resume = Boolean(job && job.processed > 0);

  const parsed = parseLibraryJobTarget(target);

  // Legacy rows may still use all-configured; new code never creates them.
  if (!parsed || parsed.kind === "all-configured") {
    const result = await rebuildConfiguredIndexes({
      onProgress,
      shouldCancel: cancel,
    });
    clearJobProgressThrottle(jobId);
    updateJob(jobId, {
      state: "completed",
      phase: "done",
      processed: result.items,
      total: result.items,
      currentProvider: null,
      message: `Rebuilt ${result.providers.join(", ")} for saves + likes (${result.items} items)`,
      finished: true,
    });
  } else {
    const result = await rebuildProviderIndex(
      parsed.library,
      parsed.provider,
      {
        resume,
        onProgress,
        shouldCancel: cancel,
      },
    );
    clearJobProgressThrottle(jobId);
    updateJob(jobId, {
      state: "completed",
      phase: "done",
      processed: result.items,
      total: result.items,
      currentProvider: parsed.provider,
      message: `Rebuilt ${target} (${result.items} items)`,
      finished: true,
    });
  }
}

function jobTargetBlockReason(target: EmbeddingJobTarget): string | null {
  const parsed = parseLibraryJobTarget(target);
  if (!parsed) return `Unknown reindex target "${target}"`;
  if (parsed.kind === "all-configured") {
    const anyConfigured = SEARCH_LIBRARIES.some(
      (library) => configuredProviders(library).length > 0,
    );
    return anyConfigured
      ? null
      : "No providers are enabled (and credentialed where required)";
  }
  if (!isProviderConfigured(parsed.provider, parsed.library)) {
    return `${parsed.provider} is not enabled for ${parsed.library} — turn it on in Settings (and add credentials if needed) before reindexing`;
  }
  return null;
}

/**
 * Why this job must not be handed to a worker, or null when it is startable.
 * Checked immediately before every spawn and inside the worker itself, so a
 * terminal row or a provider that was disabled after enqueue can never produce
 * a doomed child process.
 */
export function embeddingJobSpawnBlockReason(jobId: number): string | null {
  const job = getEmbeddingJob(jobId);
  if (!job) return `Embedding job ${jobId} no longer exists`;
  if (isTerminalJobState(job.state)) {
    return `Embedding job ${jobId} is ${job.state}; refusing to start a worker`;
  }
  return jobTargetBlockReason(job.target);
}

/** Log a failure once per distinct message; count repeats instead of spamming. */
function logJobFailure(jobId: number, message: string) {
  const state = runner();
  const seen = state.loggedFailures.get(jobId);
  if (seen && seen.message === message) {
    seen.count += 1;
    if (seen.count % 10 === 0) {
      console.error(
        `[embedding-jobs] job ${jobId}: ${message} (repeated ${seen.count}x)`,
      );
    }
    return;
  }
  state.loggedFailures.set(jobId, { message, count: 1 });
  console.error(`[embedding-jobs] job ${jobId}: ${message}`);
}

function failJob(jobId: number, error: string) {
  updateJob(jobId, {
    state: "failed",
    message: "Reindex failed",
    error,
    finished: true,
  });
  logJobFailure(jobId, error);
}





/**
 * Run one job to completion (inline). Used by the child worker entry and by
 * the parent when child workers are disabled.
 */
export async function runEmbeddingJobById(jobId: number): Promise<void> {
  const job = getEmbeddingJob(jobId);
  if (!job) throw new PermanentEmbeddingJobError(`Embedding job ${jobId} not found`);
  if (job.state !== "running" && job.state !== "pending") {
    throw new PermanentEmbeddingJobError(
      `Embedding job ${jobId} is ${job.state}; expected running or pending`,
    );
  }

  // Last-resort guard: the queue validates this before spawning, but a provider
  // can be disabled between enqueue and start. Terminal failure, never a retry.
  const blocked = jobTargetBlockReason(job.target);
  if (blocked) {
    updateJob(jobId, {
      state: "failed",
      message: "Reindex failed",
      error: blocked,
      finished: true,
    });
    throw new PermanentEmbeddingJobError(blocked);
  }

  // Worker may be started while the row is still pending (CLI) — promote.
  if (job.state === "pending") {
    updateJob(jobId, {
      state: "running",
      phase: "queued",
      message: `Starting rebuild for ${job.target}`,
    });
  }

  try {
    await runEmbeddingJobInline(jobId, job.target);
  } catch (error) {
    clearJobProgressThrottle(jobId);
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
      throw error;
    }
  } finally {
    clearJobProgressThrottle(jobId);
  }
}

/**
 * Re-queue a job for a later attempt. The row goes back to `pending` and is
 * held out of the queue until the backoff expires, so no code path can respawn
 * a worker immediately after a failure.
 */
function scheduleWorkerRetry(
  jobId: number,
  attempt: number,
  delayMs: number,
  reason: string,
) {
  const state = runner();
  state.deferredUntil.set(jobId, Date.now() + delayMs);

  const existingTimer = state.retryTimers.get(jobId);
  if (existingTimer) clearTimeout(existingTimer);

  updateJob(jobId, {
    state: "pending",
    phase: "queued",
    error: null,
    message: `${reason} — retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${MAX_EMBEDDING_WORKER_ATTEMPTS})`,
  });
  logJobFailure(jobId, `${reason} (attempt ${attempt}/${MAX_EMBEDDING_WORKER_ATTEMPTS})`);

  const timer = setTimeout(() => {
    runner().retryTimers.delete(jobId);
    runner().deferredUntil.delete(jobId);
    pumpQueue();
  }, delayMs);
  timer.unref?.();
  state.retryTimers.set(jobId, timer);
}

/** Returns true when a retry was scheduled (job stays owned by the queue). */
async function runJobViaChild(jobId: number): Promise<boolean> {
  const state = runner();
  const attempt = (state.attempts.get(jobId) ?? 0) + 1;
  state.attempts.set(jobId, attempt);

  const blocked = embeddingJobSpawnBlockReason(jobId);
  if (blocked) {
    const job = getEmbeddingJob(jobId);
    // A terminal row needs no further writes — just refuse to spawn.
    if (job && !isTerminalJobState(job.state)) failJob(jobId, blocked);
    else logJobFailure(jobId, blocked);
    return false;
  }

  const exit = await spawnEmbeddingWorker(runner(), jobId);
  const cancelRequested = shouldCancel(jobId);
  const classification = classifyWorkerExit({ ...exit, cancelRequested });
  const after = getEmbeddingJob(jobId);

  if (classification === "ok") {
    if (after && !isTerminalJobState(after.state)) {
      failJob(jobId, "Embedding worker exited without finalizing the job");
    }
    return false;
  }

  if (classification === "cancelled") {
    if (after && !isTerminalJobState(after.state)) {
      updateJob(jobId, {
        state: "cancelled",
        phase: "done",
        message: "Reindex cancelled",
        error: null,
        finished: true,
      });
    }
    return false;
  }

  // The worker already recorded its own terminal outcome (e.g. provider error,
  // write failure). Respecting it is what keeps the queue from looping.
  if (!after || isTerminalJobState(after.state)) {
    logJobFailure(jobId, after?.error ?? exit.message);
    return false;
  }

  const plan = planWorkerRetry(attempt, classification);
  if (!plan.retry) {
    failJob(
      jobId,
      `${exit.message} (gave up after ${attempt} attempt${attempt === 1 ? "" : "s"})`,
    );
    return false;
  }

  scheduleWorkerRetry(jobId, attempt, plan.delayMs, exit.message);
  return true;
}

async function executeJob(jobId: number, target: EmbeddingJobTarget) {
  const state = runner();
  let retryScheduled = false;
  try {
    if (preferChildEmbeddingWorker()) {
      retryScheduled = await runJobViaChild(jobId);
    } else {
      try {
        await runEmbeddingJobInline(jobId, target);
      } catch (error) {
        clearJobProgressThrottle(jobId);
        if (error instanceof RebuildCancelledError || shouldCancel(jobId)) {
          updateJob(jobId, {
            state: "cancelled",
            phase: "done",
            message: "Reindex cancelled",
            error: null,
            finished: true,
          });
        } else {
          failJob(
            jobId,
            error instanceof Error ? error.message : "unknown error",
          );
        }
      }
    }
  } finally {
    clearJobProgressThrottle(jobId);
    if (!retryScheduled) {
      state.cancelFlags.delete(jobId);
      state.attempts.delete(jobId);
      state.deferredUntil.delete(jobId);
      state.loggedFailures.delete(jobId);
    }
    if (state.activeJobId === jobId) state.activeJobId = null;
    if (state.activeChildJobId === jobId) {
      state.activeChild = null;
      state.activeChildJobId = null;
    }
    // Start the next pending job (if any) after this one settles.
    pumpQueue();
  }
}

/** Fail queued jobs whose provider is no longer enabled/credentialed. */
function failBlockedPendingJobs() {
  for (const job of getPendingEmbeddingJobs()) {
    const reason = jobTargetBlockReason(job.target);
    if (reason) failJob(job.id, reason);
  }
}

function startJob(state: JobRunnerState, job: EmbeddingJobRecord) {
  // Claim the job *before* writing the row: `updateJob` notifies SSE listeners
  // synchronously, those snapshots call `ensureJobRunner()`, and an unclaimed
  // runner would re-queue this row and spawn another worker for it.
  state.activeJobId = job.id;
  state.cancelFlags.set(job.id, false);
  state.deferredUntil.delete(job.id);

  updateJob(job.id, {
    state: "running",
    phase: "queued",
    message:
      job.processed > 0
        ? `Resuming rebuild for ${job.target} (${job.processed}/${job.total})`
        : `Starting rebuild for ${job.target}`,
  });

  void executeJob(job.id, job.target);
}

/** Promote the oldest startable pending job to running when the runner is idle. */
function pumpQueue() {
  const state = runner();
  withPumpGuard(state, () => {
    if (state.activeJobId !== null) return;
    // One worker child at a time, no matter how many callers pump the queue.
    if (state.activeChild) return;

    // DB may still say "running" after a crash — reclaim before starting another.
    // Ownership was just checked above, so reclaim the rows directly.
    if (getActiveEmbeddingJob()) reclaimOrphanedJobRows();

    failBlockedPendingJobs();

    const now = Date.now();
    const next = getPendingEmbeddingJobs().find(
      (job) => (state.deferredUntil.get(job.id) ?? 0) <= now,
    );
    if (!next) return;

    startJob(state, next);
  });
}

/**
 * Reclaim orphaned running rows and resume the pending queue after restart/HMR.
 * Safe to call from status polls.
 */
export function ensureJobRunner() {
  const state = runner();
  if (runnerOwnsWork(state)) return;
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
    const pairs: Array<{ library: SearchLibrary; provider: EmbeddingProvider }> =
      [];
    for (const library of SEARCH_LIBRARIES) {
      for (const provider of configuredProviders(library)) {
        pairs.push({ library, provider });
      }
    }
    if (pairs.length === 0) {
      return {
        ok: false,
        error: "No providers are enabled (and credentialed where required)",
        status: 400,
      };
    }

    const enqueued: EmbeddingJobRecord[] = [];
    const alreadyOpen: EmbeddingJobRecord[] = [];
    const refused: string[] = [];

    for (const { library, provider } of pairs) {
      const concrete = formatJobTarget(library, provider);
      const open = getOpenJobForTarget(concrete);
      if (open) {
        alreadyOpen.push(open);
        continue;
      }
      const refuse = refuseReindexIfNeeded(library, provider);
      if (refuse) {
        refused.push(refuse);
        continue;
      }
      enqueued.push(insertPendingJob(library, provider));
    }

    if (enqueued.length === 0) {
      if (refused.length > 0 && alreadyOpen.length === 0) {
        return {
          ok: false,
          error: refused[0]!,
          status: 503,
        };
      }
      return {
        ok: false,
        error:
          "All configured providers already have a pending or running reindex job for saves and likes",
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

  const parsed = parseLibraryJobTarget(target);
  if (!parsed || parsed.kind !== "provider") {
    return {
      ok: false,
      error:
        "provider must be one of: local, ollama, openai, voyage, likes-local, likes-ollama, likes-openai, likes-voyage, all-configured",
      status: 400,
    };
  }

  if (!isProviderConfigured(parsed.provider, parsed.library)) {
    return {
      ok: false,
      error: `${parsed.provider} is not enabled for ${parsed.library} — turn it on in Settings (and add credentials if needed)`,
      status: 400,
    };
  }

  const refuse = refuseReindexIfNeeded(parsed.library, parsed.provider);
  if (refuse) {
    return { ok: false, error: refuse, status: 503 };
  }

  const concrete = formatJobTarget(parsed.library, parsed.provider);
  const open = getOpenJobForTarget(concrete);
  if (open) {
    return {
      ok: false,
      error:
        open.state === "running"
          ? `A reindex job for ${concrete} is already running.`
          : `A reindex job for ${concrete} is already queued.`,
      status: 409,
      job: open,
      jobs: [open],
    };
  }

  const created = insertPendingJob(parsed.library, parsed.provider);
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

  const state = runner();
  const active = jobId ? getEmbeddingJob(jobId) : getActiveEmbeddingJob();

  // A job waiting on retry backoff is still ours; cancel it outright.
  if (active && active.state === "pending" && state.deferredUntil.has(active.id)) {
    const timer = state.retryTimers.get(active.id);
    if (timer) clearTimeout(timer);
    state.retryTimers.delete(active.id);
    state.deferredUntil.delete(active.id);
    state.attempts.delete(active.id);
    updateJob(active.id, {
      state: "cancelled",
      phase: "done",
      message: "Reindex cancelled",
      error: null,
      finished: true,
    });
    const job = getEmbeddingJob(active.id);
    return job
      ? { ok: true, job }
      : { ok: false, error: "Job disappeared", status: 500 };
  }

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

  state.cancelFlags.set(active.id, true);
  // Cooperative cancel first (clean partial state), signals if it hangs.
  scheduleEmbeddingChildTermination(runner(), active.id);
  publishJobEvent(SEARCH_STATUS_CHANNEL, true);

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
