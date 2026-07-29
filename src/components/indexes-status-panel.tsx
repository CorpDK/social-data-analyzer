"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type EmbeddingProvider = "local" | "ollama" | "openai" | "voyage";
type IndexHealth = "ready" | "partial" | "stale" | "empty" | "unavailable";

type ProviderIndexStatus = {
  provider: EmbeddingProvider;
  enabled: boolean;
  hasCredentials: boolean;
  configured: boolean;
  indexPresent: boolean;
  totalItems: number;
  embeddedCount: number;
  coveragePercent: number;
  health: IndexHealth;
  hint: string | null;
  stored: {
    provider: string;
    model: string;
    dimensions: number;
    endpoint: string | null;
    updatedAt: number | null;
  } | null;
  expected: {
    provider: string;
    model: string;
    dimensions: number;
    endpoint: string | null;
  } | null;
  tableDimensions: number | null;
};

type EmbeddingJob = {
  id: number;
  target: string;
  state: "pending" | "running" | "completed" | "failed" | "cancelled";
  phase: string;
  processed: number;
  total: number;
  percent: number;
  currentProvider: string | null;
  error: string | null;
  message: string | null;
  cancelRequested: boolean;
  startedAt: number;
  finishedAt: number | null;
  updatedAt: number;
};

type StatusPayload = {
  totalItems: number;
  ftsCount: number;
  providers: ProviderIndexStatus[];
  job: EmbeddingJob | null;
  pendingJobs: EmbeddingJob[];
  recentJobs?: EmbeddingJob[];
  cancelSupported: boolean;
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

function isStatusPayload(payload: unknown): payload is StatusPayload {
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

function normalizeStatusPayload(payload: StatusPayload): StatusPayload {
  return {
    ...payload,
    pendingJobs: Array.isArray(payload.pendingJobs) ? payload.pendingJobs : [],
  };
}

const PROVIDER_LABELS: Record<EmbeddingProvider, string> = {
  local: "Local (basic)",
  ollama: "Ollama",
  openai: "OpenAI",
  voyage: "Voyage",
};

function healthStyles(health: IndexHealth): string {
  switch (health) {
    case "ready":
      return "bg-[var(--accent-soft)] text-[var(--accent)]";
    case "partial":
      return "bg-[var(--chip)] text-[var(--warn)]";
    case "stale":
      return "bg-[var(--chip)] text-[var(--warn)]";
    case "empty":
      return "bg-[var(--chip)] text-[var(--muted)]";
    case "unavailable":
      return "bg-[var(--chip)] text-[var(--muted)]";
  }
}

function jobStateStyles(state: EmbeddingJob["state"]): string {
  switch (state) {
    case "pending":
      return "bg-[var(--chip)] text-[var(--muted)]";
    case "running":
      return "bg-[var(--accent-soft)] text-[var(--accent)]";
    case "completed":
      return "bg-[var(--accent-soft)] text-[var(--accent)]";
    case "failed":
      return "bg-[var(--chip)] text-[var(--danger)]";
    case "cancelled":
      return "bg-[var(--chip)] text-[var(--muted)]";
  }
}

function formatUpdatedAt(unix: number | null): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString();
}

function providerAvailabilityLabel(provider: ProviderIndexStatus): string {
  if (provider.configured) return "Configured";
  if (provider.hasCredentials && !provider.enabled) {
    return "Credentials saved · Disabled";
  }
  if (provider.enabled && !provider.hasCredentials) {
    return "Enabled · Missing credentials";
  }
  return "Not configured";
}

function JobSummaryRow({ job }: { job: EmbeddingJob }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span
        className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${jobStateStyles(job.state)}`}
      >
        {job.state}
      </span>
      <span className="text-[var(--muted)]">
        Target: <span className="text-[var(--ink)]">{job.target}</span>
      </span>
      {job.currentProvider && job.currentProvider !== job.target ? (
        <span className="text-[var(--muted)]">
          · Provider:{" "}
          <span className="text-[var(--ink)]">{job.currentProvider}</span>
        </span>
      ) : null}
      <span className="text-[var(--muted)]">
        · Phase: <span className="text-[var(--ink)]">{job.phase}</span>
      </span>
      {job.state !== "pending" && job.state !== "running" ? (
        <span className="text-[var(--muted)]">
          · {job.processed}/{job.total} items
        </span>
      ) : null}
    </div>
  );
}

export function IndexesStatusPanel() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [pollingStopped, setPollingStopped] = useState(false);
  const consecutiveLoadFailures = useRef(0);

  const load = useCallback(async (manual = false) => {
    if (manual) {
      consecutiveLoadFailures.current = 0;
      setPollingStopped(false);
    }
    try {
      const response = await fetch("/api/search/status");
      const payload = await readJsonResponse(
        response,
        "Failed to load index status",
      );
      if (!isStatusPayload(payload)) {
        throw new Error("The server returned an invalid index status");
      }
      consecutiveLoadFailures.current = 0;
      setPollingStopped(false);
      setData(normalizeStatusPayload(payload));
      setError(null);
    } catch (loadError) {
      consecutiveLoadFailures.current += 1;
      if (consecutiveLoadFailures.current >= 3) setPollingStopped(true);
      setError(
        loadError instanceof Error ? loadError.message : "Failed to load status",
      );
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const activeJob =
    data?.job?.state === "running" ? data.job : null;
  const pendingJobs = data?.pendingJobs ?? [];
  const queueBusy = Boolean(activeJob) || pendingJobs.length > 0;
  const openTargets = new Set(
    [
      ...(activeJob ? [activeJob.target] : []),
      ...pendingJobs.map((job) => job.target),
    ].filter(Boolean),
  );

  useEffect(() => {
    if (!queueBusy || pollingStopped) return;
    const timer = window.setInterval(() => {
      void load();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [queueBusy, load, pollingStopped]);

  async function startReindex(provider: string) {
    setPending(provider);
    setActionError(null);
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
        startError instanceof Error ? startError.message : "Failed to start reindex",
      );
    } finally {
      setPending(null);
    }
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

  return (
    <div className="space-y-4">
      {error ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--danger)]/40 bg-[var(--surface)] px-3.5 py-2 text-sm text-[var(--danger)]"
          role="alert"
        >
          <span>
            {error}
            {pollingStopped ? " Automatic polling paused." : ""}
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
      <section className={cardClass} aria-labelledby="job-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 id="job-heading" className="font-[family-name:var(--font-fraunces)] text-lg">
              Reindex progress
            </h2>
            <p className="mt-0.5 text-xs text-[var(--muted)]">
              One job runs at a time; others queue per provider. Cancel stops
              only the active job — queued jobs keep their place. Cancel is
              cooperative between items.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={secondaryButton}
              disabled={pending !== null}
              onClick={() => void load(true)}
            >
              Refresh
            </button>
            <button
              type="button"
              className={primaryButton}
              disabled={pending !== null}
              onClick={() => void startReindex("all-configured")}
            >
              {pending === "all-configured"
                ? "Queueing…"
                : "Reindex all configured"}
            </button>
            {activeJob ? (
              <button
                type="button"
                className={secondaryButton}
                disabled={pending !== null || Boolean(activeJob.cancelRequested)}
                onClick={() => void cancelReindex()}
              >
                {activeJob.cancelRequested
                  ? "Cancelling…"
                  : pending === "cancel"
                    ? "Requesting…"
                    : "Cancel active"}
              </button>
            ) : null}
          </div>
        </div>

        {activeJob ? (
          <div className="mt-4 space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
              Active job
            </p>
            <JobSummaryRow job={activeJob} />
            <div>
              <div className="mb-1 flex justify-between text-xs text-[var(--muted)]">
                <span>
                  {activeJob.processed} / {activeJob.total} items
                </span>
                <span>{activeJob.percent}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-[var(--chip)]">
                <div
                  className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
                  style={{ width: `${Math.min(100, activeJob.percent)}%` }}
                />
              </div>
            </div>
            {activeJob.message ? (
              <p className="text-sm text-[var(--muted)]" role="status">
                {activeJob.message}
              </p>
            ) : null}
            {activeJob.error ? (
              <p className="text-sm text-[var(--danger)]" role="alert">
                {activeJob.error}
              </p>
            ) : null}
          </div>
        ) : null}

        {pendingJobs.length > 0 ? (
          <div
            className={`mt-4 space-y-2 ${activeJob ? "border-t border-[var(--line)] pt-4" : ""}`}
          >
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
              Queue ({pendingJobs.length})
            </p>
            <ul className="space-y-2">
              {pendingJobs.map((job, index) => (
                <li key={job.id} className="space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-[var(--muted)]">#{index + 1}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${jobStateStyles(job.state)}`}
                    >
                      {job.state}
                    </span>
                    <span className="text-[var(--ink)]">{job.target}</span>
                  </div>
                  {job.message ? (
                    <p className="text-xs text-[var(--muted)]">{job.message}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {!queueBusy ? (
          <p className="mt-4 text-sm text-[var(--muted)]">
            No active or queued jobs.{" "}
            <Link
              href="/indexes/history"
              className="text-[var(--ink)] underline decoration-[var(--line)] underline-offset-2 transition hover:decoration-[var(--muted)]"
            >
              View history
            </Link>
          </p>
        ) : null}

        {actionError ? (
          <p className="mt-3 text-sm text-[var(--danger)]" role="alert">
            {actionError}
          </p>
        ) : null}
      </section>

      <div className="flex flex-wrap gap-3 text-xs text-[var(--muted)]">
        <span>
          Saved items:{" "}
          <span className="font-medium text-[var(--ink)]">
            {data?.totalItems ?? "—"}
          </span>
        </span>
        <span>
          FTS rows:{" "}
          <span className="font-medium text-[var(--ink)]">
            {data?.ftsCount ?? "—"}
          </span>
        </span>
      </div>

      <div className="space-y-2">
        {(data?.providers ?? []).map((provider) => {
          const label = PROVIDER_LABELS[provider.provider];
          const providerBusy = openTargets.has(provider.provider);
          const canReindex =
            provider.configured && !providerBusy && pending === null;
          const model =
            provider.stored?.model ?? provider.expected?.model ?? "—";
          const dimensions =
            provider.stored?.dimensions ??
            provider.tableDimensions ??
            provider.expected?.dimensions ??
            "—";
          const endpoint =
            provider.stored?.endpoint ??
            provider.expected?.endpoint ??
            (provider.provider === "local" ? "(local hasher)" : "—");
          return (
            <section
              key={provider.provider}
              // Shared column template across every provider row so Coverage /
              // Model / Dimensions / Endpoint / Last updated stay aligned.
              // The <dl> uses `md:contents` so its children join this grid on desktop.
              className="grid min-w-0 gap-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 md:grid-cols-[minmax(132px,1.15fr)_minmax(112px,0.9fr)_minmax(88px,1fr)_minmax(64px,0.45fr)_minmax(88px,0.9fr)_minmax(96px,0.85fr)_auto] md:items-center md:gap-x-3 md:gap-y-0 lg:gap-x-4"
              aria-labelledby={`provider-${provider.provider}`}
            >
              <div className="min-w-0 self-center">
                <div className="flex flex-wrap items-center gap-2">
                  <h3
                    id={`provider-${provider.provider}`}
                    className="font-[family-name:var(--font-fraunces)] text-base leading-tight"
                  >
                    {label}
                  </h3>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide ${healthStyles(provider.health)}`}
                  >
                    {provider.health}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-[11px] leading-snug text-[var(--muted)]">
                  {providerAvailabilityLabel(provider)}
                  {provider.indexPresent ? " · Index present" : " · No vectors yet"}
                  {providerBusy
                    ? activeJob?.target === provider.provider
                      ? " · Reindexing"
                      : " · Queued"
                    : ""}
                </p>
                {provider.hint ? (
                  <p className="mt-0.5 truncate text-[11px] leading-snug text-[var(--muted)]">
                    {provider.hint}
                  </p>
                ) : null}
              </div>

              <div className="min-w-0 self-center">
                <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-[var(--muted)]">
                  <span>
                    Coverage{" "}
                    <span className="font-medium text-[var(--ink)]">
                      {provider.embeddedCount}/{provider.totalItems}
                    </span>
                  </span>
                  <span>{provider.coveragePercent}%</span>
                </div>
                <div
                  className="h-1.5 overflow-hidden rounded-full bg-[var(--chip)]"
                  role="progressbar"
                  aria-label={`${label} index coverage`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={provider.coveragePercent}
                >
                  <div
                    className={`h-full rounded-full transition-[width] duration-300 ${
                      provider.health === "ready"
                        ? "bg-[var(--accent)]"
                        : provider.health === "stale" ||
                            provider.health === "partial"
                          ? "bg-[var(--warn)]"
                          : "bg-[var(--line)]"
                    }`}
                    style={{
                      width: `${Math.min(100, provider.coveragePercent)}%`,
                    }}
                  />
                </div>
              </div>

              <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-4 md:contents">
                <div className="min-w-0 self-center">
                  <dt className="text-[var(--muted)]">Model</dt>
                  <dd
                    className="truncate font-[family-name:var(--font-ibm)] text-xs leading-snug text-[var(--ink)]"
                    title={model}
                  >
                    {model}
                  </dd>
                </div>
                <div className="min-w-0 self-center">
                  <dt className="text-[var(--muted)]">Dimensions</dt>
                  <dd className="font-[family-name:var(--font-ibm)] text-xs leading-snug text-[var(--ink)]">
                    {dimensions}
                  </dd>
                </div>
                <div className="min-w-0 self-center">
                  <dt className="text-[var(--muted)]">Endpoint</dt>
                  <dd
                    className="truncate font-[family-name:var(--font-ibm)] text-xs leading-snug text-[var(--ink)]"
                    title={endpoint}
                  >
                    {endpoint}
                  </dd>
                </div>
                <div className="min-w-0 self-center">
                  <dt className="text-[var(--muted)]">Last updated</dt>
                  <dd className="truncate text-xs leading-snug text-[var(--ink)]">
                    {formatUpdatedAt(provider.stored?.updatedAt ?? null)}
                  </dd>
                </div>
              </dl>

              <div className="flex items-center justify-start self-center md:justify-end md:min-w-20">
                {provider.configured ? (
                  <button
                    type="button"
                    className={primaryButton}
                    disabled={!canReindex}
                    onClick={() => void startReindex(provider.provider)}
                  >
                    {pending === provider.provider
                      ? "Starting…"
                      : providerBusy
                        ? activeJob?.target === provider.provider
                          ? "Running…"
                          : "Queued"
                        : provider.health === "ready"
                          ? "Rebuild"
                          : "Reindex"}
                  </button>
                ) : (
                  <Link className={secondaryButton} href="/settings">
                    Enable
                  </Link>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
