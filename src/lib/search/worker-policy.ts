/**
 * Pure worker exit / retry policy for embedding jobs.
 * Extracted from jobs.ts so classification can be tested without the queue.
 */

/** Max worker spawns per job before it is failed for good. */
export const MAX_EMBEDDING_WORKER_ATTEMPTS = 3;

/** Backoff before re-spawning a worker; index = attempt number - 1. */
export const EMBEDDING_WORKER_RETRY_BACKOFF_MS = [1_000, 4_000, 15_000] as const;

/**
 * A worker that dies faster than this never gets retried: startup-time failures
 * (bad config, terminal job row, missing table) repeat instantly and would
 * otherwise turn into a spawn loop.
 */
export const EMBEDDING_WORKER_FAST_FAILURE_MS = 2_000;

/** Worker exit code meaning "do not retry me". */
export const EMBEDDING_WORKER_PERMANENT_EXIT_CODE = 3;

/** Job failure that must never be retried (terminal row, disabled provider). */
export class PermanentEmbeddingJobError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "PermanentEmbeddingJobError";
  }
}

export function isPermanentEmbeddingJobError(error: unknown): boolean {
  return (
    error instanceof PermanentEmbeddingJobError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { permanent?: unknown }).permanent === true)
  );
}

export type WorkerExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  /** The process could not be started at all. */
  spawnFailed: boolean;
  message: string;
};

export type WorkerExitClassification =
  | "ok"
  | "cancelled"
  | "permanent"
  | "transient";

/**
 * Decide whether a worker exit may be retried. Only slow, non-cancelled,
 * non-permanent failures are transient — anything that fails at startup is
 * permanent so the queue can never spin on it.
 */
export function classifyWorkerExit(exit: {
  code: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  spawnFailed?: boolean;
  cancelRequested?: boolean;
}): WorkerExitClassification {
  if (exit.spawnFailed) return "permanent";
  if (exit.code === 0) return "ok";
  if (exit.cancelRequested) return "cancelled";
  if (
    exit.code === EMBEDDING_WORKER_PERMANENT_EXIT_CODE ||
    exit.code === 2 // usage error
  ) {
    return "permanent";
  }
  if (exit.elapsedMs < EMBEDDING_WORKER_FAST_FAILURE_MS) return "permanent";
  return "transient";
}

export function embeddingWorkerRetryDelayMs(attempt: number): number {
  const index = Math.max(1, Math.floor(attempt)) - 1;
  return (
    EMBEDDING_WORKER_RETRY_BACKOFF_MS[index] ??
    EMBEDDING_WORKER_RETRY_BACKOFF_MS[EMBEDDING_WORKER_RETRY_BACKOFF_MS.length - 1]!
  );
}

export function planWorkerRetry(
  attempt: number,
  classification: WorkerExitClassification,
): { retry: boolean; delayMs: number } {
  if (classification !== "transient") return { retry: false, delayMs: 0 };
  if (attempt >= MAX_EMBEDDING_WORKER_ATTEMPTS) {
    return { retry: false, delayMs: 0 };
  }
  return { retry: true, delayMs: embeddingWorkerRetryDelayMs(attempt) };
}
