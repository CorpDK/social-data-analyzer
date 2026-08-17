/**
 * Process liveness / ownership helpers for embedding-worker reclaim.
 * Kept separate from job-queue so unit tests can inject probes without fs mocks.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";

/** True when `kill(pid, 0)` succeeds (process exists and is signalable). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort cmdline for ownership checks (Linux /proc, else `ps`). */
export function readProcessCmdline(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  if (process.platform === "linux") {
    try {
      return fs
        .readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .replace(/\0/g, " ")
        .trim();
    } catch {
      return null;
    }
  }

  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8",
      timeout: 1000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * True when cmdline looks like our embedding-worker child (not an unrelated PID).
 * If cmdline cannot be read, returns false — reclaim must not kill strangers.
 */
export function isOwnedEmbeddingWorkerPid(pid: number): boolean {
  const cmdline = readProcessCmdline(pid);
  if (!cmdline) return false;
  return (
    cmdline.includes("embedding-worker") ||
    /embedding-worker\.ts\b/.test(cmdline)
  );
}

export function signalProcess(
  pid: number,
  signal: NodeJS.Signals = "SIGTERM",
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Short synchronous pause (reclaim path; keep brief). */
export function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

export type ProcessProbe = {
  isAlive: (pid: number) => boolean;
  isOwnedWorker: (pid: number) => boolean;
  signal: (pid: number, signal: NodeJS.Signals) => boolean;
  sleepMs?: (ms: number) => void;
};

export const defaultProcessProbe: ProcessProbe = {
  isAlive: isProcessAlive,
  isOwnedWorker: isOwnedEmbeddingWorkerPid,
  signal: signalProcess,
  sleepMs: sleepSyncMs,
};
