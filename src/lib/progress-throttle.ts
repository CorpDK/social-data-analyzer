/**
 * Shared progress publish throttle for embedding rebuilds and import jobs.
 * Policy: flush every N items or ~1 Hz, plus force / phase-boundary ticks.
 */

export const PROGRESS_THROTTLE_EVERY_N = 50;
export const PROGRESS_THROTTLE_MIN_MS = 1_000;

/** Embedding rebuild phases that always hit SQLite / SSE. */
export const REBUILD_FORCE_PHASES = [
  "preparing",
  "fts",
  "done",
] as const;

/** Import terminal phases that always flush. Phase changes also force via lastPhase. */
export const IMPORT_FORCE_PHASES = ["completed", "failed"] as const;

export type ProgressThrottleState = {
  lastWriteAt: number;
  lastProcessed: number;
  lastPhase?: string;
};

export type ProgressThrottleTick = {
  phase: string;
  processed: number;
  total: number;
};

export type ProgressThrottleOptions = {
  everyN?: number;
  minMs?: number;
  /** Phases that always publish (in addition to force / boundaries). */
  forcePhases?: ReadonlySet<string> | readonly string[];
  force?: boolean;
  now?: number;
};

function phaseForced(
  phase: string,
  forcePhases: ProgressThrottleOptions["forcePhases"],
): boolean {
  if (!forcePhases) return false;
  if (forcePhases instanceof Set) return forcePhases.has(phase);
  return (forcePhases as readonly string[]).includes(phase);
}

/**
 * Whether a progress tick should publish (DB write / callback / SSE).
 * Always true for `force`, listed force phases, processed===0, completion,
 * phase change, everyN items, or minMs elapsed.
 */
export function shouldPublishProgress(
  progress: ProgressThrottleTick,
  state: ProgressThrottleState,
  options: ProgressThrottleOptions = {},
): boolean {
  const everyN = options.everyN ?? PROGRESS_THROTTLE_EVERY_N;
  const minMs = options.minMs ?? PROGRESS_THROTTLE_MIN_MS;
  const now = options.now ?? Date.now();

  if (options.force) return true;
  if (phaseForced(progress.phase, options.forcePhases)) return true;
  if (
    state.lastPhase !== undefined &&
    state.lastPhase !== progress.phase
  ) {
    return true;
  }
  if (progress.processed === 0) return true;
  if (progress.total > 0 && progress.processed >= progress.total) return true;
  if (progress.processed - state.lastProcessed >= everyN) return true;
  if (now - state.lastWriteAt >= minMs) return true;
  return false;
}

export function markProgressPublished(
  state: ProgressThrottleState,
  progress: ProgressThrottleTick,
  now = Date.now(),
): ProgressThrottleState {
  state.lastWriteAt = now;
  state.lastProcessed = progress.processed;
  state.lastPhase = progress.phase;
  return state;
}

export function createProgressThrottleState(): ProgressThrottleState {
  return { lastWriteAt: 0, lastProcessed: -1 };
}

/**
 * Wrap an onProgress callback so emits are throttled (~1 Hz / every N).
 * Useful for rebuild loops that would otherwise spam each item.
 */
export function createProgressThrottleEmitter<T extends ProgressThrottleTick>(
  onProgress: ((progress: T) => void | Promise<void>) | undefined,
  options: Omit<ProgressThrottleOptions, "force" | "now"> = {},
): (progress: T) => Promise<void> {
  const state = createProgressThrottleState();
  return async (progress) => {
    const now = Date.now();
    if (!shouldPublishProgress(progress, state, { ...options, now })) return;
    markProgressPublished(state, progress, now);
    await onProgress?.(progress);
  };
}
