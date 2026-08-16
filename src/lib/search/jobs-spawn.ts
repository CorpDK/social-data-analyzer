/**
 * Embedding worker child-process spawn / kill helpers.
 * Extracted from jobs.ts; queue ownership stays in jobs.ts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  mergeNodeOptionsMaxOldSpace,
  resolveEmbeddingWorkerMaxOldSpaceMb,
} from "./memory";
import type { WorkerExit } from "./worker-policy";

/** Grace period after a cancel request before the child is signalled. */
export const CANCEL_SIGTERM_GRACE_MS = 10_000;
export const CANCEL_SIGKILL_GRACE_MS = 5_000;

/** Subset of the job runner state that spawn/kill need. */
export type EmbeddingWorkerChildState = {
  activeChild: ChildProcess | null;
  activeChildJobId: number | null;
  shutdownHooked: boolean;
};

export function embeddingWorkerEnv(): NodeJS.ProcessEnv {
  const maxOldSpaceMb = resolveEmbeddingWorkerMaxOldSpaceMb();
  return {
    ...process.env,
    EMBEDDING_WORKER_INLINE: "1",
    EMBEDDING_WORKER_CHILD: "1",
    EMBEDDING_WORKER_MAX_OLD_SPACE_MB: String(maxOldSpaceMb),
    NODE_OPTIONS: mergeNodeOptionsMaxOldSpace(
      process.env.NODE_OPTIONS,
      maxOldSpaceMb,
    ),
  };
}

export function killActiveEmbeddingChild(
  state: EmbeddingWorkerChildState,
  signal: NodeJS.Signals = "SIGKILL",
) {
  const child = state.activeChild;
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

/**
 * Kill the worker if the parent exits. Deliberately no SIGINT/SIGTERM handlers:
 * adding them would suppress Node's default termination for the dev server, and
 * the child shares our process group so Ctrl-C already reaches it.
 */
export function ensureEmbeddingWorkerShutdownHook(
  state: EmbeddingWorkerChildState,
) {
  if (state.shutdownHooked) return;
  state.shutdownHooked = true;
  process.on("exit", () => killActiveEmbeddingChild(state, "SIGKILL"));
}

/** Escalate a cancel request to signals if the child ignores the cancel flag. */
export function scheduleEmbeddingChildTermination(
  state: EmbeddingWorkerChildState,
  jobId: number,
) {
  const child = state.activeChild;
  if (!child || state.activeChildJobId !== jobId) return;

  const term = setTimeout(() => {
    if (state.activeChild !== child) return;
    killActiveEmbeddingChild(state, "SIGTERM");
    const kill = setTimeout(() => {
      if (state.activeChild !== child) return;
      killActiveEmbeddingChild(state, "SIGKILL");
    }, CANCEL_SIGKILL_GRACE_MS);
    kill.unref?.();
  }, CANCEL_SIGTERM_GRACE_MS);
  term.unref?.();
}

/**
 * Spawn one worker child. Never rejects: the caller classifies the exit.
 * At most one child may be alive per process.
 */
export function spawnEmbeddingWorker(
  state: EmbeddingWorkerChildState,
  jobId: number,
): Promise<WorkerExit> {
  const script = path.join(process.cwd(), "scripts", "embedding-worker.ts");
  const tsxCli = path.join(
    process.cwd(),
    "node_modules",
    "tsx",
    "dist",
    "cli.mjs",
  );

  if (state.activeChild) {
    return Promise.resolve({
      code: null,
      signal: null,
      elapsedMs: 0,
      spawnFailed: true,
      message: `Another embedding worker (job ${state.activeChildJobId ?? "?"}) is still running`,
    });
  }

  ensureEmbeddingWorkerShutdownHook(state);

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const useNice = process.platform === "linux";
    const env = embeddingWorkerEnv();
    const child = useNice
      ? spawn(
          "nice",
          ["-n", "10", process.execPath, tsxCli, script, String(jobId)],
          {
            env,
            stdio: ["ignore", "inherit", "inherit"],
          },
        )
      : spawn(process.execPath, [tsxCli, script, String(jobId)], {
          env,
          stdio: ["ignore", "inherit", "inherit"],
        });

    state.activeChild = child;
    state.activeChildJobId = jobId;

    const finish = (exit: WorkerExit) => {
      if (settled) return;
      settled = true;
      if (state.activeChild === child) {
        state.activeChild = null;
        state.activeChildJobId = null;
      }
      resolve(exit);
    };

    child.on("error", (error) => {
      finish({
        code: null,
        signal: null,
        elapsedMs: Date.now() - startedAt,
        spawnFailed: true,
        message: `Embedding worker could not start: ${error.message}`,
      });
    });

    child.on("exit", (code, signal) => {
      finish({
        code,
        signal,
        elapsedMs: Date.now() - startedAt,
        spawnFailed: false,
        message:
          code === 0
            ? "Embedding worker finished"
            : signal
              ? `Embedding worker killed by ${signal}`
              : `Embedding worker exited with code ${code ?? "unknown"}`,
      });
    });
  });
}
