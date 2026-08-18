/**
 * Small in-process pub/sub + SSE frame helpers for background job streams.
 * Channels are process-local (same Node runtime as the job runners).
 */

export const IMPORT_JOBS_CHANNEL = "import-jobs";
export const SEARCH_STATUS_CHANNEL = "search-status";

type Listener = () => void;

type ChannelState = {
  listeners: Set<Listener>;
  coalesceTimer: ReturnType<typeof setTimeout> | null;
};

const globalForSse = globalThis as unknown as {
  __jobSseChannels?: Map<string, ChannelState>;
};

function channels(): Map<string, ChannelState> {
  if (!globalForSse.__jobSseChannels) {
    globalForSse.__jobSseChannels = new Map();
  }
  return globalForSse.__jobSseChannels;
}

function channelState(channel: string): ChannelState {
  const map = channels();
  let state = map.get(channel);
  if (!state) {
    state = { listeners: new Set(), coalesceTimer: null };
    map.set(channel, state);
  }
  return state;
}

/** Subscribe to job/status change notifications. Returns unsubscribe. */
export function subscribeJobEvents(
  channel: string,
  listener: Listener,
): () => void {
  const state = channelState(channel);
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

function notifyListeners(channel: string) {
  const state = channelState(channel);
  for (const listener of state.listeners) {
    try {
      listener();
    } catch (error) {
      console.error(`SSE listener error on ${channel}`, error);
    }
  }
}

/**
 * Notify subscribers that job/status state may have changed.
 * Coalesces bursts (progress ticks) within ~100ms.
 */
export function publishJobEvent(channel: string, immediate = false) {
  const state = channelState(channel);
  if (immediate) {
    if (state.coalesceTimer) {
      clearTimeout(state.coalesceTimer);
      state.coalesceTimer = null;
    }
    notifyListeners(channel);
    return;
  }
  if (state.coalesceTimer) return;
  state.coalesceTimer = setTimeout(() => {
    state.coalesceTimer = null;
    notifyListeners(channel);
  }, 100);
}

export function encodeSseComment(comment: string): string {
  return `: ${comment.replace(/\n/g, " ")}\n\n`;
}

export function encodeSseEvent(event: string, data: unknown): string {
  const payload = JSON.stringify(data);
  // Split multi-line JSON safely (shouldn't happen with stringify, but be correct)
  const dataLines = payload.split("\n").map((line) => `data: ${line}`).join("\n");
  return `event: ${event}\n${dataLines}\n\n`;
}

export type SseStreamOptions<T> = {
  channel: string;
  getSnapshot: () => T;
  /**
   * When true after a snapshot, also emit an `idle` event.
   * Does not close the stream (EventSource would reconnect); the client closes.
   */
  isIdle?: (snapshot: T) => boolean;
  /**
   * Cheap change detection for poll/pubsub. Prefer selected fields over
   * `JSON.stringify(snapshot)`. Default remains stringify for safety.
   */
  fingerprint?: (snapshot: T) => string;
  heartbeatMs?: number;
  /** Lightweight DB poll inside the handler as a safety net. */
  pollMs?: number;
  signal?: AbortSignal | null;
};

/**
 * Build a `text/event-stream` Response that:
 * - sends an immediate `snapshot`
 * - pushes on pub/sub + optional ~500ms poll when the fingerprint changes
 * - heartbeats every ~15–20s
 * - optionally emits `idle` when the queue is idle (client closes EventSource)
 */
export function createJobSseResponse<T>(
  options: SseStreamOptions<T>,
): Response {
  const heartbeatMs = options.heartbeatMs ?? 17_000;
  const pollMs = options.pollMs ?? 500;
  const encoder = new TextEncoder();

  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let lastFingerprint = "";
      let lastHeartbeat = Date.now();
      let idleNotified = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => void) | null = null;

      const teardown = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        unsubscribe?.();
        unsubscribe = null;
      };

      const close = () => {
        if (closed) return;
        closed = true;
        teardown();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      cleanup = () => {
        if (closed) return;
        closed = true;
        teardown();
      };

      const sendRaw = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close();
        }
      };

      const fingerprint = (snapshot: T): string => {
        try {
          if (options.fingerprint) return options.fingerprint(snapshot);
          return JSON.stringify(snapshot);
        } catch {
          return String(Date.now());
        }
      };

      const pushSnapshot = (force = false) => {
        if (closed) return;
        let snapshot: T;
        try {
          snapshot = options.getSnapshot();
        } catch (error) {
          console.error("SSE snapshot failed", error);
          sendRaw(
            encodeSseEvent("error", {
              error: "Failed to read job status",
              code: "SSE_SNAPSHOT_FAILED",
            }),
          );
          return;
        }

        const fp = fingerprint(snapshot);
        if (!force && fp === lastFingerprint) return;
        lastFingerprint = fp;
        sendRaw(encodeSseEvent("snapshot", snapshot));
        lastHeartbeat = Date.now();

        if (options.isIdle?.(snapshot)) {
          if (!idleNotified) {
            idleNotified = true;
            sendRaw(encodeSseEvent("idle", snapshot));
          }
        } else {
          idleNotified = false;
        }
      };

      // Initial snapshot
      pushSnapshot(true);

      unsubscribe = subscribeJobEvents(options.channel, () => {
        pushSnapshot(false);
      });

      pollTimer = setInterval(() => {
        pushSnapshot(false);
      }, pollMs);

      heartbeatTimer = setInterval(() => {
        if (closed) return;
        if (Date.now() - lastHeartbeat >= heartbeatMs) {
          sendRaw(encodeSseComment("ping"));
          lastHeartbeat = Date.now();
        }
      }, Math.min(5_000, heartbeatMs));

      options.signal?.addEventListener("abort", close, { once: true });
    },
    cancel() {
      cleanup?.();
      cleanup = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering (nginx etc.)
      "X-Accel-Buffering": "no",
    },
  });
}
