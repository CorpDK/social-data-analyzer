import fs from "node:fs";
import type { Pool } from "pg";
import { jobProgressPercent } from "../../job-queue";
import type { ImportJobRecord, ImportJobsStatus } from "../../import/jobs";
import type {
  EmbeddingJobRecord,
  EmbeddingJobState,
} from "../../search/jobs-records";
import type { EmbeddingProvider } from "../../search/embeddings";
import type { JobStore } from "../ports";

type EmbeddingRow = {
  id: number;
  target: string;
  state: EmbeddingJobState;
  phase: EmbeddingJobRecord["phase"];
  processed: number;
  total: number;
  current_provider: EmbeddingProvider | null;
  error: string | null;
  message: string | null;
  cancel_requested: boolean;
  started_at: Date;
  finished_at: Date | null;
  updated_at: Date;
};

type ImportRow = {
  id: number;
  filename: string;
  content_hash: string | null;
  spool_path: string;
  kind: "zip" | "json";
  state: ImportJobRecord["state"];
  phase: ImportJobRecord["phase"];
  processed: number;
  total: number;
  message: string | null;
  error: string | null;
  details: string | null;
  result: string | null;
  import_id: number | null;
  cancel_requested: boolean;
  started_at: Date;
  finished_at: Date | null;
  updated_at: Date;
};

const EMBEDDING_SELECT = `SELECT id, target, state, phase, processed, total,
  current_provider, error, message, cancel_requested, started_at, finished_at,
  updated_at FROM embedding_jobs`;
const IMPORT_SELECT = `SELECT id, filename, content_hash, spool_path, kind, state,
  phase, processed, total, message, error, details, result, import_id,
  cancel_requested, started_at, finished_at, updated_at FROM import_jobs`;

const epoch = (value: Date | null): number | null =>
  value ? Math.floor(value.getTime() / 1000) : null;

function mapEmbedding(row: EmbeddingRow): EmbeddingJobRecord {
  return {
    id: row.id,
    target: row.target,
    state: row.state,
    phase: row.phase,
    processed: row.processed,
    total: row.total,
    percent: jobProgressPercent(
      row.processed,
      row.total,
      row.state === "completed",
    ),
    currentProvider: row.current_provider,
    error: row.error,
    message: row.message,
    cancelRequested: row.cancel_requested,
    startedAt: epoch(row.started_at)!,
    finishedAt: epoch(row.finished_at),
    updatedAt: epoch(row.updated_at)!,
  };
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function mapImport(row: ImportRow): ImportJobRecord {
  return {
    id: row.id,
    filename: row.filename,
    contentHash: row.content_hash,
    spoolPath: row.spool_path,
    kind: row.kind,
    state: row.state,
    phase: row.phase,
    processed: row.processed,
    total: row.total,
    percent: jobProgressPercent(
      row.processed,
      row.total,
      row.state === "completed",
    ),
    message: row.message,
    error: row.error,
    details: parseJson(row.details),
    result: parseJson(row.result),
    importId: row.import_id,
    cancelRequested: row.cancel_requested,
    startedAt: epoch(row.started_at)!,
    finishedAt: epoch(row.finished_at),
    updatedAt: epoch(row.updated_at)!,
  };
}

export function createPostgresJobStore(pool: Pool): JobStore {
  const oneEmbedding = async (
    suffix: string,
    values: unknown[] = [],
  ): Promise<EmbeddingJobRecord | null> => {
    const result = await pool.query<EmbeddingRow>(
      `${EMBEDDING_SELECT} ${suffix}`,
      values,
    );
    return result.rows[0] ? mapEmbedding(result.rows[0]) : null;
  };
  const manyEmbeddings = async (
    suffix: string,
    values: unknown[] = [],
  ): Promise<EmbeddingJobRecord[]> => {
    const result = await pool.query<EmbeddingRow>(
      `${EMBEDDING_SELECT} ${suffix}`,
      values,
    );
    return result.rows.map(mapEmbedding);
  };
  const oneImport = async (
    suffix: string,
    values: unknown[] = [],
  ): Promise<ImportJobRecord | null> => {
    const result = await pool.query<ImportRow>(`${IMPORT_SELECT} ${suffix}`, values);
    return result.rows[0] ? mapImport(result.rows[0]) : null;
  };
  const manyImports = async (
    suffix: string,
    values: unknown[] = [],
  ): Promise<ImportJobRecord[]> => {
    const result = await pool.query<ImportRow>(`${IMPORT_SELECT} ${suffix}`, values);
    return result.rows.map(mapImport);
  };

  const getActiveImportJob = () =>
    oneImport("WHERE state = 'running' ORDER BY id ASC LIMIT 1");
  const getPendingImportJobs = () =>
    manyImports("WHERE state = 'pending' ORDER BY id ASC");
  const getRecentImportJobs = (limit = 8) =>
    manyImports(
      "WHERE state IN ('completed','failed','cancelled') ORDER BY id DESC LIMIT $1",
      [limit],
    );

  return {
    getEmbeddingJob: (id) => oneEmbedding("WHERE id = $1", [id]),
    getLatestEmbeddingJob: () => oneEmbedding("ORDER BY id DESC LIMIT 1"),
    getLatestFinishedEmbeddingJob: () =>
      oneEmbedding(
        "WHERE state IN ('completed','failed','cancelled') ORDER BY id DESC LIMIT 1",
      ),
    getActiveEmbeddingJob: () =>
      oneEmbedding("WHERE state = 'running' ORDER BY id ASC LIMIT 1"),
    getPendingEmbeddingJobs: () =>
      manyEmbeddings("WHERE state = 'pending' ORDER BY id ASC"),
    getRecentEmbeddingJobs: (limit = 8) =>
      manyEmbeddings(
        "WHERE state IN ('completed','failed','cancelled') ORDER BY id DESC LIMIT $1",
        [limit],
      ),
    listEmbeddingJobs: async (options) => {
      const limit = Math.min(
        Math.max(1, Math.floor(options?.limit ?? 50)),
        100,
      );
      const offset = Math.max(0, Math.floor(options?.offset ?? 0));
      const [count, rows] = await Promise.all([
        pool.query<{ count: string }>("SELECT count(*) FROM embedding_jobs"),
        manyEmbeddings("ORDER BY id DESC LIMIT $1 OFFSET $2", [limit, offset]),
      ]);
      return {
        jobs: rows,
        total: Number(count.rows[0]?.count ?? 0),
        limit,
        offset,
      };
    },
    getDisplayEmbeddingJob: async () =>
      (await oneEmbedding(
        "WHERE state = 'running' ORDER BY id ASC LIMIT 1",
      )) ??
      oneEmbedding(
        "WHERE state IN ('completed','failed','cancelled') ORDER BY id DESC LIMIT 1",
      ),
    getOpenJobForTarget: (target) =>
      oneEmbedding(
        "WHERE target = $1 AND state IN ('pending','running') ORDER BY id ASC LIMIT 1",
        [target],
      ),
    hasOpenEmbeddingJobForTarget: async (target) =>
      (await oneEmbedding(
        "WHERE target = $1 AND state IN ('pending','running') LIMIT 1",
        [target],
      )) !== null,

    getImportJob: (id) => oneImport("WHERE id = $1", [id]),
    getActiveImportJob,
    getPendingImportJobs,
    getLatestFinishedImportJob: () =>
      oneImport(
        "WHERE state IN ('completed','failed','cancelled') ORDER BY id DESC LIMIT 1",
      ),
    getDisplayImportJob: getActiveImportJob,
    getRecentImportJobs,
    getImportJobsStatus: async (): Promise<ImportJobsStatus> => ({
      job: await getActiveImportJob(),
      pendingJobs: await getPendingImportJobs(),
      recentJobs: await getRecentImportJobs(5),
      cancelSupported: true,
    }),

    reclaimOrphanedEmbeddingJobs: async () => {
      const cancelled = await pool.query(
        `UPDATE embedding_jobs
         SET state = 'cancelled', message = 'Cancelled after server restart',
             error = NULL, worker_pid = NULL, lease_expires_at = NULL,
             finished_at = now(), updated_at = now()
         WHERE state = 'running' AND cancel_requested`,
      );
      const resumed = await pool.query(
        `UPDATE embedding_jobs
         SET state = 'pending', phase = 'queued',
             message = 'Re-queued after server restart', error = NULL,
             worker_pid = NULL, lease_expires_at = NULL,
             finished_at = NULL, updated_at = now()
         WHERE state = 'running' AND NOT cancel_requested
           AND (lease_expires_at IS NULL OR lease_expires_at < now())`,
      );
      return {
        cancelled: cancelled.rowCount ?? 0,
        resumed: resumed.rowCount ?? 0,
        killed: 0,
        deferred: 0,
      };
    },
    reclaimOrphanedImportJobs: async () => {
      const rows = await pool.query<{ id: number; spool_path: string }>(
        "SELECT id, spool_path FROM import_jobs WHERE state = 'running'",
      );
      let requeued = 0;
      let failed = 0;
      for (const row of rows.rows) {
        if (fs.existsSync(row.spool_path)) {
          await pool.query(
            `UPDATE import_jobs SET state = 'pending', phase = 'queued',
             cancel_requested = false, message = 'Re-queued after server restart',
             error = NULL, finished_at = NULL, updated_at = now() WHERE id = $1`,
            [row.id],
          );
          requeued += 1;
        } else {
          await pool.query(
            `UPDATE import_jobs SET state = 'failed',
             error = 'Interrupted by server restart (upload spool missing)',
             message = 'Job interrupted by server restart',
             finished_at = now(), updated_at = now() WHERE id = $1`,
            [row.id],
          );
          failed += 1;
        }
      }
      return { requeued, failed };
    },
    createEmbeddingJob: async (input) => {
      const result = await pool.query<EmbeddingRow>(
        `INSERT INTO embedding_jobs(
           target,state,phase,processed,total,current_provider,message
         ) VALUES($1,'pending','queued',0,$2,NULL,$3)
         RETURNING *`,
        [input.target, input.total, input.message],
      );
      return mapEmbedding(result.rows[0]!);
    },
    updateEmbeddingJob: async (id, patch) => {
      const values: unknown[] = [];
      const sets: string[] = [];
      const add = (column: string, value: unknown) => {
        if (value === undefined) return;
        values.push(value);
        sets.push(`${column}=$${values.length}`);
      };
      add("state", patch.state);
      add("phase", patch.phase);
      add("processed", patch.processed);
      add("total", patch.total);
      add("current_provider", patch.currentProvider);
      add("error", patch.error);
      add("message", patch.message);
      add("cancel_requested", patch.cancelRequested);
      add("worker_pid", patch.workerPid);
      if (patch.finished) {
        sets.push("finished_at=now()", "worker_pid=NULL", "lease_expires_at=NULL");
      } else if (
        patch.refreshLease !== false &&
        (patch.state === "running" ||
          patch.workerPid !== undefined ||
          patch.processed !== undefined ||
          patch.phase !== undefined ||
          patch.refreshLease === true)
      ) {
        sets.push("lease_expires_at=now() + interval '30 seconds'");
      }
      sets.push("updated_at=now()");
      values.push(id);
      await pool.query(
        `UPDATE embedding_jobs SET ${sets.join(", ")} WHERE id=$${values.length}`,
        values,
      );
    },
    createImportJob: async (input) => {
      const result = await pool.query<ImportRow>(
        `INSERT INTO import_jobs(
           filename,content_hash,spool_path,kind,state,phase,processed,total,message
         ) VALUES($1,$2,$3,$4,'pending','queued',0,0,$5)
         RETURNING *`,
        [
          input.filename,
          input.contentHash,
          input.spoolPath,
          input.kind,
          input.message,
        ],
      );
      return mapImport(result.rows[0]!);
    },
    updateImportJob: async (id, patch) => {
      const values: unknown[] = [];
      const sets: string[] = [];
      const add = (column: string, value: unknown) => {
        if (value === undefined) return;
        values.push(value);
        sets.push(`${column}=$${values.length}`);
      };
      add("state", patch.state);
      add("phase", patch.phase);
      add("processed", patch.processed);
      add("total", patch.total);
      add("message", patch.message);
      add("error", patch.error);
      add(
        "details",
        patch.details === undefined
          ? undefined
          : patch.details
            ? JSON.stringify(patch.details)
            : null,
      );
      add(
        "result",
        patch.result === undefined
          ? undefined
          : patch.result
            ? JSON.stringify(patch.result)
            : null,
      );
      add("import_id", patch.importId);
      add("content_hash", patch.contentHash);
      add("cancel_requested", patch.cancelRequested);
      if (patch.finished) sets.push("finished_at=now()");
      sets.push("updated_at=now()");
      values.push(id);
      await pool.query(
        `UPDATE import_jobs SET ${sets.join(", ")} WHERE id=$${values.length}`,
        values,
      );
    },
  };
}
