"use client";

import { useEffect, useRef } from "react";

type UseJobSseOptions = {
  url: string;
  /** When false, the EventSource is closed (e.g. idle-only panels). */
  enabled: boolean;
  onSnapshot: (data: unknown) => void;
  onIdle?: (data: unknown) => void;
  onStreamError?: (message: string) => void;
  /** After this many consecutive errors, stop reconnecting until enabled toggles. */
  maxFailures?: number;
};

/**
 * Subscribe to a job/status SSE endpoint with exponential backoff reconnect.
 * EventSource auto-reconnect is disabled by closing on error and recreating.
 */
export function useJobSse({
  url,
  enabled,
  onSnapshot,
  onIdle,
  onStreamError,
  maxFailures = 8,
}: UseJobSseOptions) {
  const onSnapshotRef = useRef(onSnapshot);
  const onIdleRef = useRef(onIdle);
  const onStreamErrorRef = useRef(onStreamError);
  onSnapshotRef.current = onSnapshot;
  onIdleRef.current = onIdle;
  onStreamErrorRef.current = onStreamError;

  useEffect(() => {
    if (!enabled) return;

    let closed = false;
    let source: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let failures = 0;
    let attempt = 0;

    const clearReconnect = () => {
      if (reconnectTimer != null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const cleanupSource = () => {
      if (source) {
        source.onopen = null;
        source.onerror = null;
        source.onmessage = null;
        source.close();
        source = null;
      }
    };

    const scheduleReconnect = () => {
      if (closed) return;
      if (failures >= maxFailures) {
        onStreamErrorRef.current?.(
          "Live updates paused after repeated connection failures",
        );
        return;
      }
      clearReconnect();
      const delay = Math.min(15_000, 500 * 2 ** attempt);
      attempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (closed) return;
      cleanupSource();

      const es = new EventSource(url);
      source = es;

      es.addEventListener("snapshot", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as unknown;
          failures = 0;
          attempt = 0;
          onSnapshotRef.current(data);
        } catch {
          failures += 1;
          onStreamErrorRef.current?.("Failed to parse status update");
        }
      });

      es.addEventListener("idle", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as unknown;
          failures = 0;
          attempt = 0;
          onSnapshotRef.current(data);
          onIdleRef.current?.(data);
        } catch {
          onIdleRef.current?.(undefined);
        }
      });

      es.addEventListener("error", (event) => {
        // Server-sent error event (not connection error)
        try {
          const data = JSON.parse((event as MessageEvent).data) as {
            error?: string;
          };
          if (data?.error) onStreamErrorRef.current?.(data.error);
        } catch {
          // ignore
        }
      });

      es.onopen = () => {
        failures = 0;
      };

      es.onerror = () => {
        // Connection dropped or server closed — reconnect with backoff.
        failures += 1;
        cleanupSource();
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      closed = true;
      clearReconnect();
      cleanupSource();
    };
  }, [url, enabled, maxFailures]);
}
