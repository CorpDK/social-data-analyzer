import type Database from "better-sqlite3";
import type { JobStore } from "../ports";
import { jobProgressPercent } from "../../job-queue";
import type { ImportJobRecord } from "../../import/jobs";
import {
  getActiveEmbeddingJob,
  getDisplayEmbeddingJob,
  getEmbeddingJob,
  getLatestEmbeddingJob,
  getLatestFinishedEmbeddingJob,
  getOpenJobForTarget,
  getPendingEmbeddingJobs,
  getRecentEmbeddingJobs,
  hasOpenEmbeddingJobForTarget,
  listEmbeddingJobs,
} from "../../search/jobs-records";
import {
  reclaimOrphanedEmbeddingJobRows,
  reclaimOrphanedImportJobRows,
} from "../../job-queue";

export function createSqliteJobStore(sqlite: Database.Database): JobStore {
  const importSelect = `SELECT id,filename,content_hash,spool_path,kind,state,phase,
    processed,total,message,error,details,result,import_id,cancel_requested,
    started_at,finished_at,updated_at FROM import_jobs`;
  const mapImport = (row: Record<string, unknown>): ImportJobRecord => {
    const processed = Number(row.processed);
    const total = Number(row.total);
    const parse = <T>(value: unknown): T | null => {
      if (typeof value !== "string" || !value) return null;
      try {
        return JSON.parse(value) as T;
      } catch {
        return null;
      }
    };
    return {
      id: Number(row.id),
      filename: String(row.filename),
      contentHash: (row.content_hash as string | null) ?? null,
      spoolPath: String(row.spool_path),
      kind: row.kind === "json" ? "json" : "zip",
      state: row.state as ImportJobRecord["state"],
      phase: row.phase as ImportJobRecord["phase"],
      processed,
      total,
      percent: jobProgressPercent(processed, total, row.state === "completed"),
      message: (row.message as string | null) ?? null,
      error: (row.error as string | null) ?? null,
      details: parse(row.details),
      result: parse(row.result),
      importId: (row.import_id as number | null) ?? null,
      cancelRequested: Boolean(row.cancel_requested),
      startedAt: Number(row.started_at),
      finishedAt:
        row.finished_at === null ? null : Number(row.finished_at),
      updatedAt: Number(row.updated_at),
    };
  };
  const oneImport = (suffix: string, ...values: unknown[]) => {
    const row = sqlite.prepare(`${importSelect} ${suffix}`).get(...values) as
      | Record<string, unknown>
      | undefined;
    return row ? mapImport(row) : null;
  };
  const manyImports = (suffix: string, ...values: unknown[]) =>
    (
      sqlite.prepare(`${importSelect} ${suffix}`).all(...values) as Array<
        Record<string, unknown>
      >
    ).map(mapImport);
  const update = (
    table: "embedding_jobs" | "import_jobs",
    id: number,
    values: Record<string, unknown>,
    finished: boolean | undefined,
  ) => {
    const entries = Object.entries(values).filter((entry) => entry[1] !== undefined);
    const sets = entries.map(([column]) => `${column} = ?`);
    if (finished) {
      sets.push("finished_at = unixepoch()");
      if (table === "embedding_jobs") {
        sets.push("worker_pid = NULL", "lease_expires_at = NULL");
      }
    }
    sets.push("updated_at = unixepoch()");
    sqlite
      .prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), id);
  };
  return {
    getEmbeddingJob: async (id) => getEmbeddingJob(id),
    getLatestEmbeddingJob: async () => getLatestEmbeddingJob(),
    getLatestFinishedEmbeddingJob: async () => getLatestFinishedEmbeddingJob(),
    getActiveEmbeddingJob: async () => getActiveEmbeddingJob(),
    getPendingEmbeddingJobs: async () => getPendingEmbeddingJobs(),
    getRecentEmbeddingJobs: async (limit) => getRecentEmbeddingJobs(limit),
    listEmbeddingJobs: async (options) => listEmbeddingJobs(options),
    getDisplayEmbeddingJob: async () => getDisplayEmbeddingJob(),
    getOpenJobForTarget: async (target) => getOpenJobForTarget(target),
    hasOpenEmbeddingJobForTarget: async (target) =>
      hasOpenEmbeddingJobForTarget(target),

    getImportJob: async (id) => oneImport("WHERE id = ?", id),
    getActiveImportJob: async () =>
      oneImport("WHERE state='running' ORDER BY id ASC LIMIT 1"),
    getPendingImportJobs: async () =>
      manyImports("WHERE state='pending' ORDER BY id ASC"),
    getLatestFinishedImportJob: async () =>
      oneImport(
        "WHERE state IN ('completed','failed','cancelled') ORDER BY id DESC LIMIT 1",
      ),
    getDisplayImportJob: async () =>
      oneImport("WHERE state='running' ORDER BY id ASC LIMIT 1"),
    getRecentImportJobs: async (limit = 8) =>
      manyImports(
        "WHERE state IN ('completed','failed','cancelled') ORDER BY id DESC LIMIT ?",
        limit,
      ),
    getImportJobsStatus: async () => ({
      job: oneImport("WHERE state='running' ORDER BY id ASC LIMIT 1"),
      pendingJobs: manyImports("WHERE state='pending' ORDER BY id ASC"),
      recentJobs: manyImports(
        "WHERE state IN ('completed','failed','cancelled') ORDER BY id DESC LIMIT ?",
        5,
      ),
      cancelSupported: true,
    }),

    reclaimOrphanedEmbeddingJobs: async () =>
      reclaimOrphanedEmbeddingJobRows(sqlite),
    reclaimOrphanedImportJobs: async () =>
      reclaimOrphanedImportJobRows(sqlite),
    createEmbeddingJob: async (input) => {
      const result = sqlite
        .prepare(
          `INSERT INTO embedding_jobs(
             target,state,phase,processed,total,current_provider,message
           ) VALUES (?, 'pending', 'queued', 0, ?, NULL, ?)`,
        )
        .run(input.target, input.total, input.message);
      return getEmbeddingJob(Number(result.lastInsertRowid))!;
    },
    updateEmbeddingJob: async (id, patch) => {
      const refreshLease =
        !patch.finished &&
        patch.refreshLease !== false &&
        (patch.state === "running" ||
          patch.workerPid !== undefined ||
          patch.processed !== undefined ||
          patch.phase !== undefined ||
          patch.refreshLease === true);
      update(
        "embedding_jobs",
        id,
        {
          state: patch.state,
          phase: patch.phase,
          processed: patch.processed,
          total: patch.total,
          current_provider: patch.currentProvider,
          error: patch.error,
          message: patch.message,
          cancel_requested:
            patch.cancelRequested === undefined
              ? undefined
              : Number(patch.cancelRequested),
          worker_pid: patch.workerPid,
          lease_expires_at: refreshLease
            ? Math.floor(Date.now() / 1000) + 30
            : undefined,
        },
        patch.finished,
      );
    },
    createImportJob: async (input) => {
      const result = sqlite
        .prepare(
          `INSERT INTO import_jobs(
             filename,content_hash,spool_path,kind,state,phase,processed,total,message
           ) VALUES (?, ?, ?, ?, 'pending', 'queued', 0, 0, ?)`,
        )
        .run(
          input.filename,
          input.contentHash,
          input.spoolPath,
          input.kind,
          input.message,
        );
      return oneImport("WHERE id = ?", Number(result.lastInsertRowid))!;
    },
    updateImportJob: async (id, patch) => {
      update(
        "import_jobs",
        id,
        {
          state: patch.state,
          phase: patch.phase,
          processed: patch.processed,
          total: patch.total,
          message: patch.message,
          error: patch.error,
          details:
            patch.details === undefined
              ? undefined
              : patch.details
                ? JSON.stringify(patch.details)
                : null,
          result:
            patch.result === undefined
              ? undefined
              : patch.result
                ? JSON.stringify(patch.result)
                : null,
          import_id: patch.importId,
          content_hash: patch.contentHash,
          cancel_requested:
            patch.cancelRequested === undefined
              ? undefined
              : Number(patch.cancelRequested),
        },
        patch.finished,
      );
    },
  };
}
