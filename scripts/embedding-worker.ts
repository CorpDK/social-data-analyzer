/**
 * Child-process entry for one embedding rebuild job.
 *
 * Spawned by the Next.js job runner so heavy embed/write work does not share
 * the UI request event loop. Progress and cancel still use `embedding_jobs`
 * in SQLite (WAL); only this process should write vectors while the job runs.
 *
 * The job runner sets `NODE_OPTIONS=--max-old-space-size=…` (default 2048 MB,
 * override with `EMBEDDING_WORKER_MAX_OLD_SPACE_MB`), replacing any inherited
 * parent heap cap (e.g. Next's large max-old-space-size), and prefers
 * `nice -n 10` on Linux. Manual CLI runs should set the same env if you want
 * the heap cap.
 *
 * Usage: `pnpm embedding-worker <jobId>`
 * Or:    `pnpm exec tsx scripts/embedding-worker.ts <jobId>`
 */
import { loadEnvConfig } from "@next/env";
import { closeSqlite, getSqlite } from "../src/lib/db";
import { jobLog } from "../src/lib/job-log";
import {
  EMBEDDING_WORKER_PERMANENT_EXIT_CODE,
  isPermanentEmbeddingJobError,
  runEmbeddingJobById,
} from "../src/lib/search/jobs";
import {
  mergeNodeOptionsMaxOldSpace,
  resolveEmbeddingWorkerMaxOldSpaceMb,
} from "../src/lib/search/memory";

loadEnvConfig(process.cwd());

// Document the intended heap cap for operators inspecting env; Node only
// honors NODE_OPTIONS at process start (the parent spawn applies it).
const heapMb = resolveEmbeddingWorkerMaxOldSpaceMb();
process.env.EMBEDDING_WORKER_MAX_OLD_SPACE_MB ??= String(heapMb);
process.env.NODE_OPTIONS = mergeNodeOptionsMaxOldSpace(
  process.env.NODE_OPTIONS,
  heapMb,
);

async function main() {
  const jobId = Number(process.argv[2]);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    jobLog("embedding-worker", {
      message: "usage: pnpm embedding-worker <jobId>",
      level: "error",
    });
    process.exit(2);
  }

  // Must be set before the first getSqlite(): keeps this process from spawning
  // a child of its own and from reclaiming (re-queuing) its own job row.
  process.env.EMBEDDING_WORKER_INLINE = "1";
  process.env.EMBEDDING_WORKER_CHILD = "1";

  jobLog("embedding-worker", {
    jobId,
    message: `start heapMb=${heapMb}`,
  });

  getSqlite();
  try {
    await runEmbeddingJobById(jobId);
    jobLog("embedding-worker", { jobId, phase: "done", message: "exit=0" });
  } finally {
    closeSqlite();
  }
}

/**
 * Exit codes: 0 done, 2 bad usage, 3 permanent failure (never retry),
 * 1 possibly-transient failure (the parent may retry with backoff).
 */
main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (isPermanentEmbeddingJobError(error)) {
      // Single line, no stack: this is a configuration/state problem, and the
      // parent must not retry it.
      jobLog("embedding-worker", {
        message: `aborting: ${message}`,
        level: "error",
      });
      closeSqlite();
      process.exit(EMBEDDING_WORKER_PERMANENT_EXIT_CODE);
    }
    jobLog("embedding-worker", { message, level: "error" });
    console.error("[embedding-worker]", error);
    closeSqlite();
    process.exit(1);
  });
