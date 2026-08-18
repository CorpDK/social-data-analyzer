import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { getSqlite } from "../db";
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
  isJobCancelRequested,
  jobProgressPercent,
  reclaimOrphanedImportJobRows,
  runnerOwnsWork,
  createJobSqlSet,
  setJobColumn,
  setJobFinishedAt,
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
function reclaimOrphanedJobs() {
  const state = runner();
  if (runnerOwnsWork(state)) return;
  reclaimOrphanedJobRows();
}

/** Caller must have verified that no job is owned by this process. */
function reclaimOrphanedJobRows() {
  const result = reclaimOrphanedImportJobRows(getSqlite());
  if (result.requeued > 0 || result.failed > 0) {
    jobLog("import", {
      message: `reclaim requeued=${result.requeued} failed=${result.failed}`,
      level: "warn",
    });
    publishJobEvent(IMPORT_JOBS_CHANNEL, true);
  }
}

export function getImportJob(id: number): ImportJobRecord | null {
  const row = getSqlite()
    .prepare(`${JOB_SELECT} WHERE id = ?`)
    .get(id) as Parameters<typeof mapJobRow>[0] | undefined;
  return row ? mapJobRow(row) : null;
}

export function getActiveImportJob(): ImportJobRecord | null {
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

export function getPendingImportJobs(): ImportJobRecord[] {
  const rows = getSqlite()
    .prepare(
      `${JOB_SELECT}
       WHERE state = 'pending'
       ORDER BY id ASC`,
    )
    .all() as Parameters<typeof mapJobRow>[0][];
  return rows.map(mapJobRow);
}

export function getLatestFinishedImportJob(): ImportJobRecord | null {
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

/** Active running job for the progress panel (pending listed separately). */
export function getDisplayImportJob(): ImportJobRecord | null {
  return getActiveImportJob();
}

export function getRecentImportJobs(limit = 8): ImportJobRecord[] {
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

export type ImportJobsStatus = ImportJobsStatusDto;

/** Snapshot for GET /api/import/jobs and the SSE stream. */
export function getImportJobsStatus(): ImportJobsStatus {
  ensureImportJobRunner();
  return {
    job: getActiveImportJob(),
    pendingJobs: getPendingImportJobs(),
    recentJobs: getRecentImportJobs(5),
    cancelSupported: true,
  };
}

export function isImportQueueIdle(status: ImportJobsStatus): boolean {
  return status.job == null && status.pendingJobs.length === 0;
}

function updateJob(
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
  const sql = createJobSqlSet();

  setJobColumn(sql, "state", patch.state);
  setJobColumn(sql, "phase", patch.phase);
  setJobColumn(sql, "processed", patch.processed);
  setJobColumn(sql, "total", patch.total);
  setJobColumn(sql, "message", patch.message);
  setJobColumn(sql, "error", patch.error);
  if (patch.details !== undefined) {
    setJobColumn(
      sql,
      "details",
      patch.details ? JSON.stringify(patch.details) : null,
    );
  }
  if (patch.result !== undefined) {
    setJobColumn(
      sql,
      "result",
      patch.result ? JSON.stringify(patch.result) : null,
    );
  }
  setJobColumn(sql, "import_id", patch.importId);
  setJobColumn(sql, "content_hash", patch.contentHash);
  if (patch.finished) {
    setJobFinishedAt(sql);
  }

  sql.values.push(id);
  getSqlite()
    .prepare(`UPDATE import_jobs SET ${sql.sets.join(", ")} WHERE id = ?`)
    .run(...sql.values);

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

  updateJob(jobId, {
    phase: progress.phase,
    processed: progress.processed,
    total: progress.total,
    message: progress.message ?? null,
    details: progress.details ?? null,
    importId: progress.details?.importId ?? undefined,
  });
}

function shouldCancel(jobId: number): boolean {
  return isJobCancelRequested(
    getSqlite(),
    "import_jobs",
    jobId,
    runner().cancelFlags,
  );
}

async function executeJob(jobId: number) {
  const state = runner();
  const job = getImportJob(jobId);
  if (!job) {
    state.cancelFlags.delete(jobId);
    if (state.activeJobId === jobId) state.activeJobId = null;
    clearImportProgressThrottle(jobId);
    pumpQueue();
    return;
  }

  try {
    if (!fs.existsSync(job.spoolPath)) {
      throw new Error("Upload spool file is missing; re-upload the export.");
    }

    updateJob(jobId, {
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
      updateJob(jobId, {
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
      updateJob(jobId, {
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
      updateJob(jobId, {
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
      updateJob(jobId, {
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
      updateJob(jobId, {
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
    const finished = getImportJob(jobId);
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
    pumpQueue();
  }
}

function pumpQueue() {
  const state = runner();
  withPumpGuard(state, () => {
    if (state.activeJobId !== null) return;

    const dbActive = getActiveImportJob();
    if (dbActive) {
      reclaimOrphanedJobRows();
    }

    const next = getPendingImportJobs()[0];
    if (!next) return;

    // Claim before writing: `updateJob` notifies SSE listeners synchronously and
    // those snapshots call `ensureImportJobRunner()`, which would otherwise
    // re-enter and start this job twice.
    state.activeJobId = next.id;
    state.cancelFlags.set(next.id, false);

    updateJob(next.id, {
      state: "running",
      phase: "queued",
      message: `Starting import of ${next.filename}`,
    });

    void executeJob(next.id);
  });
}

/**
 * Reclaim orphaned running rows and resume the pending queue after restart/HMR.
 * Safe to call from status polls.
 */
export function ensureImportJobRunner() {
  const state = runner();
  if (runnerOwnsWork(state)) return;
  reclaimOrphanedJobs();
  pumpQueue();
}

export type StartImportResult =
  | { ok: true; job: ImportJobRecord }
  | { ok: false; error: string; status: number };

export async function startImportJob(file: File): Promise<StartImportResult> {
  ensureImportJobRunner();

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

  const sqlite = getSqlite();
  let jobId: number;
  try {
    const info = sqlite
      .prepare(
        `INSERT INTO import_jobs(
          filename, content_hash, spool_path, kind, state, phase,
          processed, total, message
        ) VALUES (?, ?, ?, ?, 'pending', 'queued', 0, 0, ?)`,
      )
      .run(
        filename,
        spool.contentHash,
        spool.spoolPath,
        kind,
        `Queued import of ${filename}`,
      );
    jobId = Number(info.lastInsertRowid);
  } catch (error) {
    deleteSpoolFile(spool.spoolPath);
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Failed to create import job",
      status: 500,
    };
  }

  publishJobEvent(IMPORT_JOBS_CHANNEL, true);
  pumpQueue();
  const job = getImportJob(jobId);
  if (!job) {
    return { ok: false, error: "Failed to create import job", status: 500 };
  }
  return { ok: true, job };
}

export type CancelImportResult =
  | { ok: true; job: ImportJobRecord }
  | { ok: false; error: string; status: number; job?: ImportJobRecord };

/**
 * Cooperative cancel for a running job (or the active one). Pending jobs can
 * be cancelled by deleting them from the queue before they start.
 */
export function cancelImportJob(jobId?: number): CancelImportResult {
  ensureImportJobRunner();

  const target = jobId ? getImportJob(jobId) : getActiveImportJob();
  if (!target) {
    return { ok: false, error: "No import job to cancel", status: 404 };
  }

  if (target.state === "pending") {
    getSqlite()
      .prepare(
        `UPDATE import_jobs
         SET state = 'cancelled',
             phase = 'failed',
             message = 'Import cancelled before start',
             finished_at = unixepoch(),
             updated_at = unixepoch()
         WHERE id = ?`,
      )
      .run(target.id);
    deleteSpoolFile(target.spoolPath);
    publishJobEvent(IMPORT_JOBS_CHANNEL, true);
    const job = getImportJob(target.id);
    if (!job) return { ok: false, error: "Job disappeared", status: 500 };
    pumpQueue();
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

  getSqlite()
    .prepare(
      `UPDATE import_jobs
       SET cancel_requested = 1,
           message = 'Cancel requested…',
           updated_at = unixepoch()
       WHERE id = ?`,
    )
    .run(target.id);

  runner().cancelFlags.set(target.id, true);
  publishJobEvent(IMPORT_JOBS_CHANNEL, true);

  const job = getImportJob(target.id);
  if (!job) return { ok: false, error: "Job disappeared", status: 500 };
  return { ok: true, job };
}

/** Test helper: wait until the import queue is idle. */
export async function waitForIdleImportJob(
  timeoutMs = 60_000,
): Promise<ImportJobRecord | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    ensureImportJobRunner();
    const active = getActiveImportJob();
    const pending = getPendingImportJobs();
    if (!active && pending.length === 0) {
      return getLatestFinishedImportJob();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for import job queue to finish");
}
