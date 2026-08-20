import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { getStorage } from "../storage";
import {
  ImportCancelledError,
  importExportArchive,
  importExportJson,
  type ImportProgress,
  type ImportProgressDetails,
  type ImportProgressPhase,
  type ImportResult,
} from "../import-export";
import {
  importFileTooLargeMessage,
  importKindFromFilename,
  importMaxBytesForKind,
} from "../import-limits";
import {
  deleteSpoolFile,
  readSpoolFile,
  spoolUploadedFile,
} from "./spool";
import { IMPORT_JOBS_CHANNEL, publishJobEvent } from "../sse";
import {
  jobProgressPercent,
  runnerOwnsWork,
  withPumpGuard,
} from "../job-queue";
import { jobLog } from "../job-log";
import {
  createProgressThrottleState,
  IMPORT_FORCE_PHASES,
  markProgressPublished,
  shouldPublishProgress,
  type ProgressThrottleState,
} from "../progress-throttle";
import type {
  ImportJobKind as ImportJobKindDto,
  ImportJobState as ImportJobStateDto,
  ImportJobsStatusDto,
} from "./jobs-dto";

export type { ImportJobDetailsDto as ImportProgressDetailsWire } from "./jobs-dto";
export type ImportJobState = ImportJobStateDto;
export type ImportJobKind = ImportJobKindDto;

export type ImportJobRecord = {
  id: number;
  filename: string;
  contentHash: string | null;
  spoolPath: string;
  kind: ImportJobKind;
  state: ImportJobState;
  phase: ImportProgressPhase | "queued";
  processed: number;
  total: number;
  percent: number;
  message: string | null;
  error: string | null;
  details: ImportProgressDetails | null;
  result: ImportResult | null;
  importId: number | null;
  cancelRequested: boolean;
  startedAt: number;
  finishedAt: number | null;
  updatedAt: number;
};

type JobRunnerState = {
  activeJobId: number | null;
  cancelFlags: Map<number, boolean>;
  /** Guards re-entry: job writes publish SSE events synchronously. */
  pumping: boolean;
};

const globalForImportJobs = globalThis as unknown as {
  importJobRunner?: JobRunnerState;
};

/** Per-job progress write throttle (~1 Hz / every N items). */
const importProgressThrottle = new Map<number, ProgressThrottleState>();

function clearImportProgressThrottle(jobId: number) {
  importProgressThrottle.delete(jobId);
}

function runner(): JobRunnerState {
  const state = globalForImportJobs.importJobRunner;
  if (!state) {
    const fresh: JobRunnerState = {
      activeJobId: null,
      cancelFlags: new Map(),
      pumping: false,
    };
    globalForImportJobs.importJobRunner = fresh;
    return fresh;
  }
  if ((state as Partial<JobRunnerState>).pumping === undefined) {
    state.pumping = false;
  }
  return state;
}

function parseDetails(raw: string | null): ImportProgressDetails | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ImportProgressDetails;
  } catch {
    return null;
  }
}

function parseResult(raw: string | null): ImportResult | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ImportResult;
  } catch {
    return null;
  }
}

function mapJobRow(row: {
  id: number;
  filename: string;
  content_hash: string | null;
  spool_path: string;
  kind: string;
  state: string;
  phase: string;
  processed: number;
  total: number;
  message: string | null;
  error: string | null;
  details: string | null;
  result: string | null;
  import_id: number | null;
  cancel_requested: number;
  started_at: number;
  finished_at: number | null;
  updated_at: number;
}): ImportJobRecord {
  const total = row.total;
  const processed = row.processed;
  const percent = jobProgressPercent(
    processed,
    total,
    row.state === "completed",
  );

  return {
    id: row.id,
    filename: row.filename,
    contentHash: row.content_hash,
    spoolPath: row.spool_path,
    kind: row.kind === "json" ? "json" : "zip",
    state: row.state as ImportJobState,
    phase: row.phase as ImportJobRecord["phase"],
    processed,
    total,
    percent,
    message: row.message,
    error: row.error,
    details: parseDetails(row.details),
    result: parseResult(row.result),
    importId: row.import_id,
    cancelRequested: Boolean(row.cancel_requested),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

const JOB_SELECT = `SELECT id, filename, content_hash, spool_path, kind, state, phase,
              processed, total, message, error, details, result, import_id,
              cancel_requested, started_at, finished_at, updated_at
       FROM import_jobs`;

/** Mark orphaned running rows: re-queue if spool exists, else fail. */
async function reclaimOrphanedJobs() {
  const state = runner();
  if (runnerOwnsWork(state)) return;
  await reclaimOrphanedJobRows();
}

/** Caller must have verified that no job is owned by this process. */
async function reclaimOrphanedJobRows() {
  const result = await (await getStorage()).jobs.reclaimOrphanedImportJobs();
  if (result.requeued > 0 || result.failed > 0) {
    jobLog("import", {
      message: `reclaim requeued=${result.requeued} failed=${result.failed}`,
      level: "warn",
    });
    publishJobEvent(IMPORT_JOBS_CHANNEL, true);
  }
}

export async function getImportJob(id: number): Promise<ImportJobRecord | null> {
  return (await getStorage()).jobs.getImportJob(id);
}

export async function getActiveImportJob(): Promise<ImportJobRecord | null> {
  return (await getStorage()).jobs.getActiveImportJob();
}

export async function getPendingImportJobs(): Promise<ImportJobRecord[]> {
  return (await getStorage()).jobs.getPendingImportJobs();
}

export async function getLatestFinishedImportJob(): Promise<ImportJobRecord | null> {
  return (await getStorage()).jobs.getLatestFinishedImportJob();
}

/** Active running job for the progress panel (pending listed separately). */
export async function getDisplayImportJob(): Promise<ImportJobRecord | null> {
  return getActiveImportJob();
}

export async function getRecentImportJobs(limit = 8): Promise<ImportJobRecord[]> {
  return (await getStorage()).jobs.getRecentImportJobs(limit);
}

export type ImportJobsStatus = ImportJobsStatusDto;

/** Snapshot for GET /api/import/jobs and the SSE stream. */
export async function getImportJobsStatus(): Promise<ImportJobsStatus> {
  await ensureImportJobRunner();
  return (await getStorage()).jobs.getImportJobsStatus();
}

export function isImportQueueIdle(status: ImportJobsStatus): boolean {
  return status.job == null && status.pendingJobs.length === 0;
}

async function updateJob(
  id: number,
  patch: {
    state?: ImportJobState;
    phase?: ImportJobRecord["phase"];
    processed?: number;
    total?: number;
    message?: string | null;
    error?: string | null;
    details?: ImportProgressDetails | null;
    result?: ImportResult | null;
    importId?: number | null;
    contentHash?: string | null;
    finished?: boolean;
  },
) {
  await (await getStorage()).jobs.updateImportJob(id, patch);

  const immediate = Boolean(
    patch.state !== undefined || patch.finished === true,
  );
  publishJobEvent(IMPORT_JOBS_CHANNEL, immediate);
}

async function applyProgress(jobId: number, progress: ImportProgress) {
  const state = importProgressThrottle.get(jobId) ?? createProgressThrottleState();
  const now = Date.now();
  if (
    !shouldPublishProgress(progress, state, {
      forcePhases: IMPORT_FORCE_PHASES,
      now,
    })
  ) {
    return;
  }
  markProgressPublished(state, progress, now);
  importProgressThrottle.set(jobId, state);

  jobLog("import", {
    jobId,
    phase: progress.phase,
    processed: progress.processed,
    total: progress.total,
    message: progress.message,
  });

  await updateJob(jobId, {
    phase: progress.phase,
    processed: progress.processed,
    total: progress.total,
    message: progress.message ?? null,
    details: progress.details ?? null,
    importId: progress.details?.importId ?? undefined,
  });
}

function shouldCancel(jobId: number): boolean {
  return runner().cancelFlags.get(jobId) === true;
}

async function executeJob(jobId: number) {
  const state = runner();
  const job = await getImportJob(jobId);
  if (!job) {
    state.cancelFlags.delete(jobId);
    if (state.activeJobId === jobId) state.activeJobId = null;
    clearImportProgressThrottle(jobId);
    void pumpQueue();
    return;
  }

  try {
    if (!fs.existsSync(job.spoolPath)) {
      throw new Error("Upload spool file is missing; re-upload the export.");
    }

    await updateJob(jobId, {
      phase: "received",
      message: `Reading ${job.filename}…`,
    });
    jobLog("import", {
      jobId,
      phase: "received",
      message: `start kind=${job.kind} file=${job.filename}`,
    });

    const onProgress = (progress: ImportProgress) =>
      applyProgress(jobId, progress);
    const cancel = () => shouldCancel(jobId);

    let result;
    if (job.kind === "json") {
      const buffer = readSpoolFile(job.spoolPath);
      if (buffer.byteLength === 0) {
        throw new Error("File is empty.");
      }
      const jsonMax = importMaxBytesForKind("json");
      if (buffer.byteLength > jsonMax) {
        throw new Error(importFileTooLargeMessage("json"));
      }
      result = await importExportJson(buffer.toString("utf8"), job.filename, {
        onProgress,
        shouldCancel: cancel,
        contentHash: job.contentHash ?? undefined,
      });
    } else {
      const stat = fs.statSync(job.spoolPath);
      if (stat.size === 0) {
        throw new Error("File is empty.");
      }
      const zipMax = importMaxBytesForKind("zip");
      if (stat.size > zipMax) {
        throw new Error(importFileTooLargeMessage("zip"));
      }
      // Stream from spool path — do not readFileSync the whole zip into RAM.
      result = await importExportArchive(job.spoolPath, job.filename, {
        onProgress,
        shouldCancel: cancel,
        contentHash: job.contentHash ?? undefined,
      });
    }

    if (shouldCancel(jobId)) {
      await updateJob(jobId, {
        state: "cancelled",
        phase: "failed",
        message: "Import cancelled",
        error: null,
        result,
        importId: result.importId,
        finished: true,
      });
      jobLog("import", {
        jobId,
        phase: "failed",
        message: "cancelled",
        level: "warn",
      });
    } else if (result.status === "failed") {
      await updateJob(jobId, {
        state: "failed",
        phase: "failed",
        message: result.message,
        error: result.message,
        result,
        importId: result.importId,
        finished: true,
      });
      jobLog("import", {
        jobId,
        phase: "failed",
        message: result.message,
        level: "error",
      });
    } else {
      await updateJob(jobId, {
        state: "completed",
        phase: "completed",
        processed: result.itemsFound + result.likesFound,
        total: Math.max(1, result.itemsFound + result.likesFound),
        message: result.message,
        error: null,
        result,
        importId: result.importId,
        details: {
          importId: result.importId,
          itemsParsed: result.itemsFound,
          likesParsed: result.likesFound,
          itemsAdded: result.itemsAdded,
          itemsUpdated: result.itemsUpdated,
          itemsSkipped: result.itemsSkipped,
          likesAdded: result.likesAdded,
          likesUpdated: result.likesUpdated,
          likesSkipped: result.likesSkipped,
        },
        finished: true,
      });
      jobLog("import", {
        jobId,
        phase: "completed",
        processed: result.itemsFound + result.likesFound,
        total: Math.max(1, result.itemsFound + result.likesFound),
        message: result.message,
      });
    }
  } catch (error) {
    if (error instanceof ImportCancelledError || shouldCancel(jobId)) {
      const cancelMessage =
        error instanceof ImportCancelledError
          ? error.message
          : "Import cancelled";
      await updateJob(jobId, {
        state: "cancelled",
        phase: "failed",
        message: cancelMessage,
        error: null,
        finished: true,
      });
      jobLog("import", {
        jobId,
        phase: "failed",
        message: "cancelled",
        level: "warn",
      });
    } else {
      const errMsg = error instanceof Error ? error.message : "unknown error";
      await updateJob(jobId, {
        state: "failed",
        phase: "failed",
        message: errMsg,
        error: errMsg,
        finished: true,
      });
      jobLog("import", {
        jobId,
        phase: "failed",
        message: errMsg,
        level: "error",
      });
    }
  } finally {
    const finished = await getImportJob(jobId);
    if (
      finished &&
      (finished.state === "completed" ||
        finished.state === "failed" ||
        finished.state === "cancelled")
    ) {
      deleteSpoolFile(finished.spoolPath);
    }

    state.cancelFlags.delete(jobId);
    if (state.activeJobId === jobId) state.activeJobId = null;
    clearImportProgressThrottle(jobId);
    void pumpQueue();
  }
}

async function pumpQueue() {
  const state = runner();
  if (state.pumping) return;
  state.pumping = true;
  try {
    if (state.activeJobId !== null) return;

    const dbActive = await getActiveImportJob();
    if (dbActive) {
      await reclaimOrphanedJobRows();
    }

    const next = (await getPendingImportJobs())[0];
    if (!next) return;

    // Claim before writing: `updateJob` notifies SSE listeners synchronously and
    // those snapshots call `ensureImportJobRunner()`, which would otherwise
    // re-enter and start this job twice.
    state.activeJobId = next.id;
    state.cancelFlags.set(next.id, false);

    await updateJob(next.id, {
      state: "running",
      phase: "queued",
      message: `Starting import of ${next.filename}`,
    });

    void executeJob(next.id);
  } finally {
    state.pumping = false;
  }
}

/**
 * Reclaim orphaned running rows and resume the pending queue after restart/HMR.
 * Safe to call from status polls.
 */
export async function ensureImportJobRunner() {
  const state = runner();
  if (runnerOwnsWork(state)) return;
  await reclaimOrphanedJobs();
  await pumpQueue();
}

export type StartImportResult =
  | { ok: true; job: ImportJobRecord }
  | { ok: false; error: string; status: number };

async function enqueueImportFromSpool(args: {
  filename: string;
  kind: ImportJobKind;
  spoolPath: string;
  contentHash: string;
}): Promise<StartImportResult> {
  await ensureImportJobRunner();
  let created: ImportJobRecord;
  try {
    created = await (await getStorage()).jobs.createImportJob({
      ...args,
      message: `Queued import of ${args.filename}`,
    });
  } catch (error) {
    deleteSpoolFile(args.spoolPath);
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Failed to create import job",
      status: 500,
    };
  }

  publishJobEvent(IMPORT_JOBS_CHANNEL, true);
  await pumpQueue();
  const job = await getImportJob(created.id);
  if (!job) {
    return { ok: false, error: "Failed to create import job", status: 500 };
  }
  return { ok: true, job };
}

/** Enqueue after a streaming multipart spool (preferred upload path). */
export async function startImportJobFromSpool(args: {
  filename: string;
  kind: ImportJobKind;
  spoolPath: string;
  contentHash: string;
  byteLength: number;
}): Promise<StartImportResult> {
  const maxBytes = importMaxBytesForKind(args.kind);
  if (args.byteLength > maxBytes) {
    deleteSpoolFile(args.spoolPath);
    return { ok: false, error: importFileTooLargeMessage(args.kind), status: 413 };
  }
  if (args.byteLength <= 0) {
    deleteSpoolFile(args.spoolPath);
    return { ok: false, error: "File is empty.", status: 400 };
  }
  return enqueueImportFromSpool(args);
}

export async function startImportJob(file: File): Promise<StartImportResult> {
  const filename = file.name || "export.zip";
  const kind = importKindFromFilename(filename);
  if (!kind) {
    return {
      ok: false,
      error: "Only .zip and .json exports are supported.",
      status: 400,
    };
  }

  const maxBytes = importMaxBytesForKind(kind);
  if (typeof file.size === "number" && file.size > maxBytes) {
    return { ok: false, error: importFileTooLargeMessage(kind), status: 400 };
  }

  const token = `${Date.now()}-${randomBytes(6).toString("hex")}`;

  let spool;
  try {
    spool = await spoolUploadedFile(file, token, {
      maxBytes,
      tooLargeMessage: importFileTooLargeMessage(kind),
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to store upload",
      status: 400,
    };
  }

  return enqueueImportFromSpool({
    filename,
    kind,
    spoolPath: spool.spoolPath,
    contentHash: spool.contentHash,
  });
}

export type CancelImportResult =
  | { ok: true; job: ImportJobRecord }
  | { ok: false; error: string; status: number; job?: ImportJobRecord };

/**
 * Cooperative cancel for a running job (or the active one). Pending jobs can
 * be cancelled by deleting them from the queue before they start.
 */
export async function cancelImportJob(jobId?: number): Promise<CancelImportResult> {
  await ensureImportJobRunner();

  const target = jobId ? await getImportJob(jobId) : await getActiveImportJob();
  if (!target) {
    return { ok: false, error: "No import job to cancel", status: 404 };
  }

  if (target.state === "pending") {
    await updateJob(target.id, {
      state: "cancelled",
      phase: "failed",
      message: "Import cancelled before start",
      finished: true,
    });
    deleteSpoolFile(target.spoolPath);
    publishJobEvent(IMPORT_JOBS_CHANNEL, true);
    const job = await getImportJob(target.id);
    if (!job) return { ok: false, error: "Job disappeared", status: 500 };
    await pumpQueue();
    return { ok: true, job };
  }

  if (target.state !== "running") {
    return {
      ok: false,
      error: "Import job is not running or pending",
      status: 404,
      job: target,
    };
  }

  await (await getStorage()).jobs.updateImportJob(target.id, {
    cancelRequested: true,
    message: "Cancel requested…",
  });

  runner().cancelFlags.set(target.id, true);
  publishJobEvent(IMPORT_JOBS_CHANNEL, true);

  const job = await getImportJob(target.id);
  if (!job) return { ok: false, error: "Job disappeared", status: 500 };
  return { ok: true, job };
}

/** Test helper: wait until the import queue is idle. */
export async function waitForIdleImportJob(
  timeoutMs = 60_000,
): Promise<ImportJobRecord | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await ensureImportJobRunner();
    const active = await getActiveImportJob();
    const pending = await getPendingImportJobs();
    if (!active && pending.length === 0) {
      return getLatestFinishedImportJob();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for import job queue to finish");
}
