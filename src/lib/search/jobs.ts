import type { ChildProcess } from "node:child_process";
import { getStorage } from "../storage";
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
  rebuildKeywordIndexes,
  rebuildProviderIndex,
  type RebuildProgress,
} from "./sync";
import { configuredProviders, isProviderConfigured } from "./providers";
import {
  runnerOwnsWork,
  withPumpGuard,
} from "../job-queue";
import { jobLog } from "../job-log";
import { SEARCH_STATUS_CHANNEL, publishJobEvent } from "../sse";
import {
  engineSwitchBusyMessage,
  isEngineSwitchRunning,
} from "../storage/engine-switch";
import {
  classifyWorkerExit,
  MAX_EMBEDDING_WORKER_ATTEMPTS,
  PermanentEmbeddingJobError,
  planWorkerRetry,
} from "./worker-policy";
import {
  parseReindexTarget,
  type EmbeddingJobPhase,
  type EmbeddingJobRecord,
  type EmbeddingJobState,
  type EmbeddingJobTarget,
} from "./jobs-records";

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

export type {
  EmbeddingJobPhase,
  EmbeddingJobRecord,
  EmbeddingJobState,
  EmbeddingJobTarget,
};
export {
  parseReindexTarget,
};

export async function getEmbeddingJob(id: number) {
  return (await getStorage()).jobs.getEmbeddingJob(id);
}
export async function getLatestEmbeddingJob() {
  return (await getStorage()).jobs.getLatestEmbeddingJob();
}
export async function getLatestFinishedEmbeddingJob() {
  return (await getStorage()).jobs.getLatestFinishedEmbeddingJob();
}
export async function getActiveEmbeddingJob() {
  return (await getStorage()).jobs.getActiveEmbeddingJob();
}
export async function getPendingEmbeddingJobs() {
  return (await getStorage()).jobs.getPendingEmbeddingJobs();
}
export async function getRecentEmbeddingJobs(limit?: number) {
  return (await getStorage()).jobs.getRecentEmbeddingJobs(limit);
}
export async function listEmbeddingJobs(options?: { limit?: number; offset?: number }) {
  return (await getStorage()).jobs.listEmbeddingJobs(options);
}
export async function getDisplayEmbeddingJob() {
  return (await getStorage()).jobs.getDisplayEmbeddingJob();
}
export async function getOpenJobForTarget(target: EmbeddingJobTarget) {
  return (await getStorage()).jobs.getOpenJobForTarget(target);
}
export async function hasOpenEmbeddingJobForTarget(target: EmbeddingJobTarget) {
  return (await getStorage()).jobs.hasOpenEmbeddingJobForTarget(target);
}

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
  void reclaimOrphanedJobRows();
}

/** Caller must have verified that no job is owned by this process. */
async function reclaimOrphanedJobRows() {
  const result = await (await getStorage()).jobs.reclaimOrphanedEmbeddingJobs();
  if (
    result.cancelled > 0 ||
    result.resumed > 0 ||
    result.killed > 0 ||
    result.deferred > 0
  ) {
    jobLog("search", {
      message: `reclaim cancelled=${result.cancelled} resumed=${result.resumed} killed=${result.killed} deferred=${result.deferred}`,
      level: "warn",
    });
    publishJobEvent(SEARCH_STATUS_CHANNEL, true);
  }
}

const jobProgressThrottle = new Map<number, JobProgressThrottle>();

async function updateJob(
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
    workerPid?: number | null;
    /** Refresh worker lease heartbeat (default true while running). */
    refreshLease?: boolean;
  },
) {
  await (await getStorage()).jobs.updateEmbeddingJob(id, patch);

  const immediate = Boolean(
    patch.state !== undefined || patch.finished === true,
  );
  publishJobEvent(SEARCH_STATUS_CHANNEL, immediate);
}

async function setEmbeddingJobWorkerPid(jobId: number, pid: number | null) {
  await updateJob(jobId, { workerPid: pid });
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

  jobLog("search", {
    jobId,
    phase: progress.phase,
    processed: progress.processed,
    total: progress.total,
    message: progress.message ?? progress.currentProvider ?? undefined,
  });

  await updateJob(jobId, {
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
  return runner().cancelFlags.get(jobId) === true;
}

async function insertPendingJob(
  library: SearchLibrary,
  provider: EmbeddingProvider,
): Promise<EmbeddingJobRecord> {
  const storage = await getStorage();
  const totalItems =
    library === "saves"
      ? (await storage.search.allSavesSearchRows()).length
      : (await storage.search.allLikesSearchRows()).length;
  const target = formatJobTarget(library, provider);

  const job = await storage.jobs.createEmbeddingJob({
    target,
    total: totalItems,
    message: `Queued rebuild for ${target}`,
  });
  publishJobEvent(SEARCH_STATUS_CHANNEL, true);
  return job;
}

async function insertPendingFtsJob(): Promise<EmbeddingJobRecord> {
  const storage = await getStorage();
  const saves = (await storage.search.allSavesSearchRows()).length;
  const likes = (await storage.search.allLikesSearchRows()).length;
  const totalItems = saves + likes;

  const job = await storage.jobs.createEmbeddingJob({
    target: "fts",
    total: totalItems,
    message: "Queued keyword (FTS) index backfill",
  });
  publishJobEvent(SEARCH_STATUS_CHANNEL, true);
  return job;
}

/** Whether a pending/running job already covers this concrete target. */
/**
 * Enqueue a keyword-index backfill job when none is already open.
 * Used by readiness scheduling — not by browse/list GETs.
 */
export async function enqueueFtsBackfillJob(): Promise<EmbeddingJobRecord | null> {
  await ensureJobRunner();
  if (await getOpenJobForTarget("fts")) return null;
  const job = await insertPendingFtsJob();
  void pumpQueue();
  return (await getEmbeddingJob(job.id)) ?? job;
}

async function libraryItemCount(library: SearchLibrary): Promise<number> {
  const search = (await getStorage()).search;
  return library === "saves"
    ? (await search.allSavesSearchRows()).length
    : (await search.allLikesSearchRows()).length;
}

/**
 * Hard refuse any provider reindex when free RAM is critically low, or when
 * a large library is below that provider's MemAvailable floor. Soft warnings
 * are logged separately.
 */
async function refuseReindexIfNeeded(
  library: SearchLibrary,
  provider: EmbeddingProvider,
): Promise<string | null> {
  const assessment = assessReindexMemory(
    library,
    provider,
    await libraryItemCount(library),
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
  const job = await getEmbeddingJob(jobId);
  const resume = Boolean(job && job.processed > 0);

  const parsed = parseLibraryJobTarget(target);

  // Legacy rows may still use all-configured; new code never creates them.
  if (!parsed || parsed.kind === "all-configured") {
    const result = await rebuildConfiguredIndexes({
      onProgress,
      shouldCancel: cancel,
    });
    clearJobProgressThrottle(jobId);
    await updateJob(jobId, {
      state: "completed",
      phase: "done",
      processed: result.items,
      total: result.items,
      currentProvider: null,
      message: `Rebuilt ${result.providers.join(", ")} for saves + likes (${result.items} items)`,
      finished: true,
    });
  } else if (parsed.kind === "fts") {
    const result = await rebuildKeywordIndexes({
      onProgress,
      shouldCancel: cancel,
    });
    const total = result.saves + result.likes;
    clearJobProgressThrottle(jobId);
    await updateJob(jobId, {
      state: "completed",
      phase: "done",
      processed: total,
      total,
      currentProvider: null,
      message: result.rebuilt
        ? `Rebuilt keyword indexes (saves ${result.saves}, likes ${result.likes})`
        : `Keyword indexes already current (saves ${result.saves}, likes ${result.likes})`,
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
    await updateJob(jobId, {
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

async function jobTargetBlockReason(target: EmbeddingJobTarget): Promise<string | null> {
  const parsed = parseLibraryJobTarget(target);
  if (!parsed) return `Unknown reindex target "${target}"`;
  if (parsed.kind === "all-configured") {
    const anyConfigured = (
      await Promise.all(SEARCH_LIBRARIES.map(configuredProviders))
    ).some((providers) => providers.length > 0);
    return anyConfigured
      ? null
      : "No providers are enabled (and credentialed where required)";
  }
  if (parsed.kind === "fts") return null;
  if (!(await isProviderConfigured(parsed.provider, parsed.library))) {
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
export async function embeddingJobSpawnBlockReason(jobId: number): Promise<string | null> {
  const job = await getEmbeddingJob(jobId);
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
      jobLog("search", {
        jobId,
        message: `${message} (repeated ${seen.count}x)`,
        level: "error",
      });
    }
    return;
  }
  state.loggedFailures.set(jobId, { message, count: 1 });
  jobLog("search", { jobId, message, level: "error" });
}

async function failJob(jobId: number, error: string) {
  await updateJob(jobId, {
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
  const job = await getEmbeddingJob(jobId);
  if (!job) throw new PermanentEmbeddingJobError(`Embedding job ${jobId} not found`);
  if (job.state !== "running" && job.state !== "pending") {
    throw new PermanentEmbeddingJobError(
      `Embedding job ${jobId} is ${job.state}; expected running or pending`,
    );
  }

  // Last-resort guard: the queue validates this before spawning, but a provider
  // can be disabled between enqueue and start. Terminal failure, never a retry.
  const blocked = await jobTargetBlockReason(job.target);
  if (blocked) {
    await updateJob(jobId, {
      state: "failed",
      message: "Reindex failed",
      error: blocked,
      finished: true,
    });
    throw new PermanentEmbeddingJobError(blocked);
  }

  // Worker may be started while the row is still pending (CLI) — promote.
  if (job.state === "pending") {
    await updateJob(jobId, {
      state: "running",
      phase: "queued",
      message: `Starting rebuild for ${job.target}`,
    });
  }

  try {
    await runEmbeddingJobInline(jobId, job.target);
    const after = await getEmbeddingJob(jobId);
    if (after && after.state === "completed") {
      jobLog("search", {
        jobId,
        phase: "done",
        processed: after.processed,
        total: after.total,
        message: `completed target=${job.target}`,
      });
    }
  } catch (error) {
    clearJobProgressThrottle(jobId);
    if (error instanceof RebuildCancelledError || shouldCancel(jobId)) {
      await updateJob(jobId, {
        state: "cancelled",
        phase: "done",
        message: "Reindex cancelled",
        error: null,
        finished: true,
      });
      jobLog("search", {
        jobId,
        phase: "done",
        message: `cancelled target=${job.target}`,
        level: "warn",
      });
    } else {
      await updateJob(jobId, {
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
async function scheduleWorkerRetry(
  jobId: number,
  attempt: number,
  delayMs: number,
  reason: string,
) {
  const state = runner();
  state.deferredUntil.set(jobId, Date.now() + delayMs);

  const existingTimer = state.retryTimers.get(jobId);
  if (existingTimer) clearTimeout(existingTimer);

  await updateJob(jobId, {
    state: "pending",
    phase: "queued",
    error: null,
    workerPid: null,
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

  const blocked = await embeddingJobSpawnBlockReason(jobId);
  if (blocked) {
    const job = await getEmbeddingJob(jobId);
    // A terminal row needs no further writes — just refuse to spawn.
    if (job && !isTerminalJobState(job.state)) await failJob(jobId, blocked);
    else logJobFailure(jobId, blocked);
    return false;
  }

  const exit = await spawnEmbeddingWorker(runner(), jobId, {
    onSpawned: (pid) => {
      void setEmbeddingJobWorkerPid(jobId, pid);
    },
  });
  const cancelRequested = shouldCancel(jobId);
  const classification = classifyWorkerExit({ ...exit, cancelRequested });
  const after = await getEmbeddingJob(jobId);

  if (classification === "ok") {
    if (after && !isTerminalJobState(after.state)) {
      await failJob(jobId, "Embedding worker exited without finalizing the job");
    }
    return false;
  }

  if (classification === "cancelled") {
    if (after && !isTerminalJobState(after.state)) {
      await updateJob(jobId, {
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
    await failJob(
      jobId,
      `${exit.message} (gave up after ${attempt} attempt${attempt === 1 ? "" : "s"})`,
    );
    return false;
  }

  await scheduleWorkerRetry(jobId, attempt, plan.delayMs, exit.message);
  return true;
}

async function executeJob(jobId: number, target: EmbeddingJobTarget) {
  const state = runner();
  let retryScheduled = false;
  try {
    if (preferChildEmbeddingWorker()) {
      retryScheduled = await runJobViaChild(jobId);
    } else {
      // Inline / test worker: record this process so a foreign reclaim can see ownership.
      await setEmbeddingJobWorkerPid(jobId, process.pid);
      try {
        await runEmbeddingJobInline(jobId, target);
      } catch (error) {
        clearJobProgressThrottle(jobId);
        if (error instanceof RebuildCancelledError || shouldCancel(jobId)) {
          await updateJob(jobId, {
            state: "cancelled",
            phase: "done",
            message: "Reindex cancelled",
            error: null,
            finished: true,
          });
        } else {
          await failJob(
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
async function failBlockedPendingJobs() {
  for (const job of await getPendingEmbeddingJobs()) {
    const reason = await jobTargetBlockReason(job.target);
    if (reason) await failJob(job.id, reason);
  }
}

async function startJob(state: JobRunnerState, job: EmbeddingJobRecord) {
  // Claim the job *before* writing the row: `updateJob` notifies SSE listeners
  // synchronously, those snapshots call `ensureJobRunner()`, and an unclaimed
  // runner would re-queue this row and spawn another worker for it.
  state.activeJobId = job.id;
  state.cancelFlags.set(job.id, false);
  state.deferredUntil.delete(job.id);

  await updateJob(job.id, {
    state: "running",
    phase: "queued",
    message:
      job.processed > 0
        ? `Resuming rebuild for ${job.target} (${job.processed}/${job.total})`
        : `Starting rebuild for ${job.target}`,
  });
  jobLog("search", {
    jobId: job.id,
    phase: "queued",
    processed: job.processed,
    total: job.total,
    message:
      job.processed > 0
        ? `resume target=${job.target}`
        : `start target=${job.target}`,
  });

  void executeJob(job.id, job.target);
}

/** Promote the oldest startable pending job to running when the runner is idle. */
async function pumpQueue() {
  const state = runner();
  if (state.pumping) return;
  state.pumping = true;
  try {
    if (state.activeJobId !== null) return;
    // One worker child at a time, no matter how many callers pump the queue.
    if (state.activeChild) return;

    // DB may still say "running" after a crash — reclaim before starting another.
    // Ownership was just checked above, so reclaim the rows directly.
    if (await getActiveEmbeddingJob()) {
      await reclaimOrphanedJobRows();
      void pumpQueue();
      return;
    }
    await failBlockedPendingJobs();

    const now = Date.now();
    const next = (await getPendingEmbeddingJobs()).find(
      (job) => (state.deferredUntil.get(job.id) ?? 0) <= now,
    );
    if (!next) return;

    await startJob(state, next);
  } finally {
    state.pumping = false;
  }
}

/**
 * Reclaim orphaned running rows and resume the pending queue after restart/HMR.
 * Safe to call from status polls.
 */
export async function ensureJobRunner() {
  const state = runner();
  if (runnerOwnsWork(state)) return;
  await reclaimOrphanedJobRows();
  await pumpQueue();
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

export async function startReindexJob(target: EmbeddingJobTarget): Promise<StartReindexResult> {
  if (isEngineSwitchRunning()) {
    return {
      ok: false,
      error: engineSwitchBusyMessage("start a reindex"),
      status: 409,
    };
  }
  await ensureJobRunner();

  if (target === "all-configured") {
    const pairs: Array<{ library: SearchLibrary; provider: EmbeddingProvider }> =
      [];
    for (const library of SEARCH_LIBRARIES) {
      for (const provider of await configuredProviders(library)) {
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
      const open = await getOpenJobForTarget(concrete);
      if (open) {
        alreadyOpen.push(open);
        continue;
      }
      const refuse = await refuseReindexIfNeeded(library, provider);
      if (refuse) {
        refused.push(refuse);
        continue;
      }
      enqueued.push(await insertPendingJob(library, provider));
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
        job: (await getActiveEmbeddingJob()) ?? alreadyOpen[0],
        jobs: alreadyOpen,
      };
    }

    await pumpQueue();

    const jobs = [...enqueued];
    const active = await getActiveEmbeddingJob();
    const job =
      active && jobs.some((j) => j.id === active.id)
        ? active
        : ((await getEmbeddingJob(enqueued[0]!.id)) ?? enqueued[0]!);

    return {
      ok: true,
      job,
      jobs: await Promise.all(
        jobs.map(async (j) => (await getEmbeddingJob(j.id)) ?? j),
      ),
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

  if (!(await isProviderConfigured(parsed.provider, parsed.library))) {
    return {
      ok: false,
      error: `${parsed.provider} is not enabled for ${parsed.library} — turn it on in Settings (and add credentials if needed)`,
      status: 400,
    };
  }

  const refuse = await refuseReindexIfNeeded(parsed.library, parsed.provider);
  if (refuse) {
    return { ok: false, error: refuse, status: 503 };
  }

  const concrete = formatJobTarget(parsed.library, parsed.provider);
  const open = await getOpenJobForTarget(concrete);
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

  const created = await insertPendingJob(parsed.library, parsed.provider);
  await pumpQueue();
  const job = (await getEmbeddingJob(created.id)) ?? created;
  return { ok: true, job, jobs: [job] };
}

export type CancelReindexResult =
  | { ok: true; job: EmbeddingJobRecord }
  | { ok: false; error: string; status: number; job?: EmbeddingJobRecord };

/**
 * Cancel the active (running) job only. Pending queued jobs remain and will
 * start after the active job settles (cancelled / completed / failed).
 */
export async function cancelReindexJob(jobId?: number): Promise<CancelReindexResult> {
  await ensureJobRunner();

  const state = runner();
  const active = jobId ? await getEmbeddingJob(jobId) : await getActiveEmbeddingJob();

  // A job waiting on retry backoff is still ours; cancel it outright.
  if (active && active.state === "pending" && state.deferredUntil.has(active.id)) {
    const timer = state.retryTimers.get(active.id);
    if (timer) clearTimeout(timer);
    state.retryTimers.delete(active.id);
    state.deferredUntil.delete(active.id);
    state.attempts.delete(active.id);
    await updateJob(active.id, {
      state: "cancelled",
      phase: "done",
      message: "Reindex cancelled",
      error: null,
      finished: true,
    });
    const job = await getEmbeddingJob(active.id);
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

  await (await getStorage()).jobs.updateEmbeddingJob(active.id, {
    cancelRequested: true,
    message: "Cancel requested…",
  });

  state.cancelFlags.set(active.id, true);
  // Cooperative cancel first (clean partial state), signals if it hangs.
  scheduleEmbeddingChildTermination(runner(), active.id);
  publishJobEvent(SEARCH_STATUS_CHANNEL, true);

  const job = await getEmbeddingJob(active.id);
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
    await ensureJobRunner();
    const active = await getActiveEmbeddingJob();
    const pending = await getPendingEmbeddingJobs();
    if (!active && pending.length === 0) return getLatestEmbeddingJob();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for embedding job queue to finish");
}
