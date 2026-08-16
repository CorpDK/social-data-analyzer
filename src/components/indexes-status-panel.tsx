"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { IndexesProgressCard } from "@/components/indexes-progress-card";
import { IndexesProviderList } from "@/components/indexes-provider-list";
import type {
  LibraryIndexStatusDto,
  ProviderIndexStatusDto,
  SearchIndexStatusDto,
} from "@/lib/search/status-dto";
import { useJobSse } from "@/lib/use-job-sse";

type PendingConfirm = {
  provider: string;
  title: string;
  body: string;
  strong: boolean;
};

function errorFromPayload(payload: unknown, fallback: string): string {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return fallback;
}

async function readJsonResponse(
  response: Response,
  fallback: string,
): Promise<unknown> {
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(
        response.ok
          ? "The server returned an invalid response"
          : `${fallback} (HTTP ${response.status})`,
      );
    }
  }
  if (!response.ok) {
    throw new Error(
      errorFromPayload(payload, `${fallback} (HTTP ${response.status})`),
    );
  }
  if (payload === null) throw new Error("The server returned an empty response");
  return payload;
}

function isStatusPayload(payload: unknown): payload is SearchIndexStatusDto {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      "totalItems" in payload &&
      typeof payload.totalItems === "number" &&
      "ftsCount" in payload &&
      typeof payload.ftsCount === "number" &&
      "providers" in payload &&
      Array.isArray(payload.providers),
  );
}

function normalizeStatusPayload(
  payload: SearchIndexStatusDto,
): SearchIndexStatusDto {
  return {
    ...payload,
    pendingJobs: Array.isArray(payload.pendingJobs) ? payload.pendingJobs : [],
  };
}

export function IndexesStatusPanel() {
  const [data, setData] = useState<SearchIndexStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [streamPaused, setStreamPaused] = useState(false);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const consecutiveLoadFailures = useRef(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmTitleId = useId();
  const confirmDescId = useId();

  const applySnapshot = useCallback((payload: unknown) => {
    if (!isStatusPayload(payload)) return false;
    consecutiveLoadFailures.current = 0;
    setStreamPaused(false);
    setData(normalizeStatusPayload(payload));
    setError(null);
    return true;
  }, []);

  const load = useCallback(
    async (manual = false) => {
      if (manual) {
        consecutiveLoadFailures.current = 0;
        setStreamPaused(false);
      }
      try {
        const response = await fetch("/api/search/status");
        const payload = await readJsonResponse(
          response,
          "Failed to load index status",
        );
        if (!applySnapshot(payload)) {
          throw new Error("The server returned an invalid index status");
        }
      } catch (loadError) {
        consecutiveLoadFailures.current += 1;
        if (consecutiveLoadFailures.current >= 3) setStreamPaused(true);
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load status",
        );
      }
    },
    [applySnapshot],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (confirm) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [confirm]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    function onCancel(event: Event) {
      event.preventDefault();
      setConfirm(null);
    }
    dialog.addEventListener("cancel", onCancel);
    return () => dialog.removeEventListener("cancel", onCancel);
  }, []);

  useJobSse({
    url: "/api/search/status/stream",
    enabled: !streamPaused,
    onSnapshot: (payload) => {
      if (!applySnapshot(payload)) {
        setError("The server returned an invalid index status");
      }
    },
    onStreamError: (message) => {
      consecutiveLoadFailures.current += 1;
      if (consecutiveLoadFailures.current >= 3) setStreamPaused(true);
      setError(message);
    },
  });

  const activeJob = data?.job?.state === "running" ? data.job : null;
  const pendingJobs = data?.pendingJobs ?? [];
  const queueBusy = Boolean(activeJob) || pendingJobs.length > 0;
  const openTargets = new Set(
    [
      ...(activeJob ? [activeJob.target] : []),
      ...pendingJobs.map((job) => job.target),
    ].filter(Boolean),
  );

  // Indexes UI only lists providers enabled for that library (Settings toggles).
  // Disabled rows (e.g. credentials saved but toggled off) stay off this page.
  const libraries: LibraryIndexStatusDto[] = [
    data?.libraries?.saves ?? {
      library: "saves" as const,
      libraryLabel: "Saves",
      totalItems: data?.totalItems ?? 0,
      ftsCount: data?.ftsCount ?? 0,
      providers: data?.providers ?? [],
    },
    data?.libraries?.likes ?? {
      library: "likes" as const,
      libraryLabel: "Likes",
      totalItems: 0,
      ftsCount: 0,
      providers: [],
    },
  ].map((library) => ({
    ...library,
    providers: library.providers.filter((provider) => provider.enabled),
  }));

  function findProvider(target: string): ProviderIndexStatusDto | null {
    for (const library of libraries) {
      const match = library.providers.find(
        (provider) => (provider.target ?? provider.provider) === target,
      );
      if (match) return match;
    }
    return null;
  }

  function warningForTarget(provider: string): {
    refused: boolean;
    refuseReason: string | null;
    warning: string | null;
    strong: boolean;
  } {
    if (provider === "all-configured") {
      const configured = libraries.flatMap((library) =>
        library.providers.filter((row) => row.configured),
      );
      const refusedRows = configured.filter((row) => row.reindexRefused);
      const messages: string[] = [];
      let strong = false;

      if (configured.length > 0 && refusedRows.length === configured.length) {
        const reason =
          refusedRows[0]?.reindexRefuseReason ??
          "Reindex refused: host RAM is too low for all configured providers.";
        return {
          refused: true,
          refuseReason: reason,
          warning: reason,
          strong: true,
        };
      }

      for (const row of configured) {
        if (row.reindexRefused && row.reindexRefuseReason) {
          strong = true;
          messages.push(row.reindexRefuseReason);
        } else if (row.reindexStrongWarning) {
          strong = true;
          messages.push(row.reindexStrongWarning);
        } else if (row.reindexWarning) {
          messages.push(row.reindexWarning);
        }
      }
      const host = data?.host;
      const hostLine =
        host?.memAvailableMb != null
          ? `Host MemAvailable ~${Math.round(host.memAvailableMb)} MB.`
          : null;
      if (refusedRows.length > 0) {
        strong = true;
      }
      return {
        refused: false,
        refuseReason: null,
        warning:
          messages.length > 0
            ? [...messages.slice(0, 3), hostLine].filter(Boolean).join("\n\n")
            : hostLine,
        strong,
      };
    }

    const row = findProvider(provider);
    if (!row) {
      return {
        refused: false,
        refuseReason: null,
        warning: null,
        strong: false,
      };
    }
    if (row.reindexRefused) {
      return {
        refused: true,
        refuseReason: row.reindexRefuseReason ?? "Reindex refused",
        warning: row.reindexRefuseReason ?? null,
        strong: true,
      };
    }
    const warning = row.reindexStrongWarning ?? row.reindexWarning ?? null;
    return {
      refused: false,
      refuseReason: null,
      warning,
      strong: Boolean(row.reindexStrongWarning),
    };
  }

  async function executeReindex(provider: string) {
    setPending(provider);
    setActionError(null);
    setConfirm(null);
    try {
      const response = await fetch("/api/search/reindex", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      await readJsonResponse(response, "Failed to start reindex");
      await load();
    } catch (startError) {
      setActionError(
        startError instanceof Error
          ? startError.message
          : "Failed to start reindex",
      );
    } finally {
      setPending(null);
    }
  }

  function requestReindex(provider: string) {
    const risk = warningForTarget(provider);
    if (risk.refused && risk.refuseReason) {
      setActionError(risk.refuseReason);
      return;
    }
    if (risk.warning) {
      setConfirm({
        provider,
        title: risk.strong ? "Large / low-RAM reindex" : "Confirm reindex",
        body: risk.warning,
        strong: risk.strong,
      });
      return;
    }
    void executeReindex(provider);
  }

  async function cancelReindex() {
    setPending("cancel");
    setActionError(null);
    try {
      const response = await fetch("/api/search/reindex/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      await readJsonResponse(response, "Failed to cancel");
      await load();
    } catch (cancelError) {
      setActionError(
        cancelError instanceof Error ? cancelError.message : "Failed to cancel",
      );
    } finally {
      setPending(null);
    }
  }

  const cardClass =
    "rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 sm:p-5";
  const secondaryButton =
    "rounded-full border border-[var(--line)] px-3 py-1.5 text-xs font-medium text-[var(--muted)] transition hover:border-[var(--muted)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40";
  const primaryButton =
    "control-active rounded-full px-3.5 py-1.5 text-xs font-medium transition hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:cursor-not-allowed disabled:opacity-40";

  if (error && !data) {
    return (
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--danger)]/40 bg-[var(--surface)] px-3.5 py-2 text-sm text-[var(--danger)]"
        role="alert"
      >
        <span>{error}</span>
        <button
          type="button"
          className="rounded-full border border-current px-3 py-1 text-xs font-medium"
          onClick={() => void load(true)}
        >
          Retry
        </button>
      </div>
    );
  }

  const host = data?.host;

  return (
    <div className="space-y-4">
      <dialog
        ref={dialogRef}
        aria-labelledby={confirmTitleId}
        aria-describedby={confirmDescId}
        className="m-auto w-[min(100%,28rem)] rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-0 text-[var(--ink)] shadow-xl backdrop:bg-black/45 open:flex open:flex-col"
      >
        {confirm ? (
          <div className="space-y-4 p-5">
            <div className="space-y-1.5">
              <h3
                id={confirmTitleId}
                className={`font-[family-name:var(--font-fraunces)] text-xl ${
                  confirm.strong ? "text-[var(--warn)]" : ""
                }`}
              >
                {confirm.title}
              </h3>
              <p
                id={confirmDescId}
                className="whitespace-pre-wrap text-sm text-[var(--muted)]"
              >
                {confirm.body}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={secondaryButton}
                onClick={() => setConfirm(null)}
                disabled={pending !== null}
                autoFocus
              >
                Cancel
              </button>
              <button
                type="button"
                className={primaryButton}
                disabled={pending !== null}
                onClick={() => void executeReindex(confirm.provider)}
              >
                {pending === confirm.provider ? "Starting…" : "Continue"}
              </button>
            </div>
          </div>
        ) : null}
      </dialog>

      {error ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--danger)]/40 bg-[var(--surface)] px-3.5 py-2 text-sm text-[var(--danger)]"
          role="alert"
        >
          <span>
            {error}
            {streamPaused ? " Live updates paused." : ""}
          </span>
          <button
            type="button"
            className="rounded-full border border-current px-3 py-1 text-xs font-medium"
            onClick={() => void load(true)}
          >
            Retry
          </button>
        </div>
      ) : null}

      <IndexesProgressCard
        cardClass={cardClass}
        secondaryButton={secondaryButton}
        primaryButton={primaryButton}
        host={host}
        activeJob={activeJob}
        pendingJobs={pendingJobs}
        queueBusy={queueBusy}
        pending={pending}
        actionError={actionError}
        onRefresh={() => void load(true)}
        onReindexAll={() => requestReindex("all-configured")}
        onCancel={() => void cancelReindex()}
      />

      <IndexesProviderList
        libraries={libraries}
        openTargets={openTargets}
        activeJob={activeJob}
        pending={pending}
        primaryButton={primaryButton}
        secondaryButton={secondaryButton}
        onRequestReindex={requestReindex}
      />
    </div>
  );
}
