"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_FILE_LABEL,
  importFileTooLargeMessage,
} from "@/lib/import-limits";
import { useJobSse } from "@/lib/use-job-sse";

type ImportJobState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

type ImportJobDetails = {
  filesScanned?: number;
  jsonFiles?: number;
  schemasInferred?: number;
  itemsParsed?: number;
  likesParsed?: number;
  itemsAdded?: number;
  itemsUpdated?: number;
  itemsSkipped?: number;
  likesAdded?: number;
  likesUpdated?: number;
  likesSkipped?: number;
  importId?: number | null;
};

type ImportJobResult = {
  importId?: number | null;
  status?: "completed" | "duplicate" | "failed";
  message?: string;
  itemsFound?: number;
  itemsAdded?: number;
  itemsUpdated?: number;
  itemsSkipped?: number;
  likesFound?: number;
  likesAdded?: number;
  likesUpdated?: number;
  likesSkipped?: number;
};

type ImportJob = {
  id: number;
  filename: string;
  state: ImportJobState;
  phase: string;
  processed: number;
  total: number;
  percent: number;
  message: string | null;
  error: string | null;
  details: ImportJobDetails | null;
  result: ImportJobResult | null;
  importId: number | null;
  cancelRequested: boolean;
  startedAt: number;
  finishedAt: number | null;
  updatedAt: number;
};

type JobsPayload = {
  job: ImportJob | null;
  pendingJobs: ImportJob[];
  recentJobs?: ImportJob[];
  cancelSupported?: boolean;
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

function isJobsPayload(payload: unknown): payload is JobsPayload {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      "pendingJobs" in payload &&
      Array.isArray((payload as JobsPayload).pendingJobs),
  );
}

function jobStateStyles(state: ImportJobState): string {
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

function phaseLabel(phase: string): string {
  switch (phase) {
    case "queued":
      return "Queued";
    case "received":
      return "Received";
    case "extracting":
      return "Extracting zip";
    case "inferring_schemas":
      return "Inferring schemas";
    case "parsing_saves":
      return "Parsing saves";
    case "parsing_likes":
      return "Parsing likes";
    case "writing":
      return "Writing library";
    case "indexing":
      return "Semantic indexing";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return phase;
  }
}

function DetailCounts({ details }: { details: ImportJobDetails | null }) {
  if (!details) return null;
  const parts: string[] = [];
  if (details.jsonFiles != null) parts.push(`${details.jsonFiles} JSON files`);
  if (details.schemasInferred != null) {
    parts.push(`${details.schemasInferred} schemas`);
  }
  if (details.itemsParsed != null) parts.push(`${details.itemsParsed} saves`);
  if (details.likesParsed != null) parts.push(`${details.likesParsed} likes`);
  if (
    details.itemsAdded != null ||
    details.itemsUpdated != null ||
    details.itemsSkipped != null
  ) {
    parts.push(
      `saves +${details.itemsAdded ?? 0} / ~${details.itemsUpdated ?? 0} / =${details.itemsSkipped ?? 0}`,
    );
  }
  if (
    details.likesAdded != null ||
    details.likesUpdated != null ||
    details.likesSkipped != null
  ) {
    parts.push(
      `likes +${details.likesAdded ?? 0} / ~${details.likesUpdated ?? 0} / =${details.likesSkipped ?? 0}`,
    );
  }
  if (parts.length === 0) return null;
  return (
    <p className="font-[family-name:var(--font-ibm)] text-xs text-[var(--muted)]">
      {parts.join(" · ")}
    </p>
  );
}

function applyJobsPayload(payload: JobsPayload): JobsPayload {
  return {
    ...payload,
    pendingJobs: Array.isArray(payload.pendingJobs) ? payload.pendingJobs : [],
  };
}

export function UploadForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<JobsPayload | null>(null);
  const [streamPaused, setStreamPaused] = useState(false);
  const consecutiveLoadFailures = useRef(0);
  const prevQueueBusy = useRef(false);

  const applySnapshot = useCallback((payload: unknown) => {
    if (!isJobsPayload(payload)) return false;
    consecutiveLoadFailures.current = 0;
    setStreamPaused(false);
    setData(applyJobsPayload(payload));
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
        const response = await fetch("/api/import/jobs");
        const payload = await readJsonResponse(
          response,
          "Failed to load import status",
        );
        if (!applySnapshot(payload)) {
          throw new Error("The server returned an invalid import status");
        }
      } catch (loadError) {
        consecutiveLoadFailures.current += 1;
        if (consecutiveLoadFailures.current >= 3) setStreamPaused(true);
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load import status",
        );
      }
    },
    [applySnapshot],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const activeJob = data?.job?.state === "running" ? data.job : null;
  const pendingJobs = data?.pendingJobs ?? [];
  const queueBusy = Boolean(activeJob) || pendingJobs.length > 0;

  useJobSse({
    url: "/api/import/jobs/stream",
    enabled: queueBusy && !streamPaused,
    onSnapshot: (payload) => {
      if (!applySnapshot(payload)) {
        setError("The server returned an invalid import status");
      }
    },
    onIdle: (payload) => {
      if (payload) applySnapshot(payload);
      if (prevQueueBusy.current) {
        router.refresh();
      }
      prevQueueBusy.current = false;
    },
    onStreamError: (message) => {
      consecutiveLoadFailures.current += 1;
      if (consecutiveLoadFailures.current >= 3) setStreamPaused(true);
      setError(message);
    },
  });

  useEffect(() => {
    if (prevQueueBusy.current && !queueBusy) {
      router.refresh();
    }
    prevQueueBusy.current = queueBusy;
  }, [queueBusy, router]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) {
      setError("Choose a .zip or .json export first.");
      return;
    }

    if (file.size > IMPORT_MAX_FILE_BYTES) {
      setError(importFileTooLargeMessage());
      return;
    }

    setUploading(true);
    setError(null);

    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/import", {
        method: "POST",
        body,
      });
      await readJsonResponse(response, "Failed to start import");
      setFile(null);
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setUploading(false);
    }
  }

  async function cancelJob(jobId?: number) {
    setActionPending("cancel");
    setError(null);
    try {
      const response = await fetch("/api/import/jobs/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(jobId != null ? { jobId } : {}),
      });
      await readJsonResponse(response, "Failed to cancel");
      await load(true);
    } catch (cancelError) {
      setError(
        cancelError instanceof Error
          ? cancelError.message
          : "Failed to cancel import",
      );
    } finally {
      setActionPending(null);
    }
  }

  const secondaryButton =
    "rounded-full border border-[var(--line)] px-3 py-1.5 text-xs font-medium text-[var(--muted)] transition hover:border-[var(--muted)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="space-y-4">
      <form
        onSubmit={onSubmit}
        className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-6 shadow-[0_20px_60px_-40px_rgba(28,36,33,0.45)]"
      >
        <div className="space-y-2">
          <h2 className="font-[family-name:var(--font-fraunces)] text-2xl tracking-tight">
            Load an export
          </h2>
          <p className="max-w-2xl text-[var(--muted)]">
            Upload Instagram&apos;s official data download as JSON (.zip or a
            saved_*.json file). Full Meta exports with media are supported up to{" "}
            {IMPORT_MAX_FILE_LABEL}. Import runs in the background — you can
            leave this page; progress is saved and resumes after refresh.
          </p>
        </div>

        <label className="mt-6 flex cursor-pointer flex-col items-start gap-3 rounded-xl border border-dashed border-[var(--accent)]/40 bg-[var(--accent-soft)]/40 px-5 py-8 transition hover:bg-[var(--accent-soft)]/70">
          <span className="text-sm font-medium text-[var(--accent)]">
            Drop or choose export file
          </span>
          <input
            type="file"
            accept=".zip,.json,application/zip,application/json"
            className="block w-full text-sm text-[var(--muted)] file:mr-4 file:rounded-full file:border-0 file:bg-[var(--ink)] file:px-4 file:py-2 file:text-sm file:text-[var(--surface)]"
            onChange={(event) => {
              const next = event.target.files?.[0] ?? null;
              setFile(next);
              if (next && next.size > IMPORT_MAX_FILE_BYTES) {
                setError(importFileTooLargeMessage());
              } else {
                setError(null);
              }
            }}
          />
          {file ? (
            <span className="font-[family-name:var(--font-ibm)] text-xs text-[var(--muted)]">
              {file.name} · {(file.size / (1024 * 1024)).toFixed(2)} MB
              {file.size > IMPORT_MAX_FILE_BYTES
                ? ` (over ${IMPORT_MAX_FILE_LABEL} limit)`
                : ""}
            </span>
          ) : null}
        </label>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={
              uploading ||
              !file ||
              (file != null && file.size > IMPORT_MAX_FILE_BYTES)
            }
            className="rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-white transition enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uploading
              ? "Uploading…"
              : queueBusy
                ? "Queue another import"
                : "Import into library"}
          </button>
          <span className="text-sm text-[var(--muted)]">
            One job runs at a time; others queue. Identical files refresh
            metadata by content hash.
          </span>
        </div>

        {error ? (
          <p
            className="mt-4 rounded-lg border border-[var(--danger)]/40 bg-[var(--surface)] px-3 py-2 text-sm text-[var(--danger)]"
            role="alert"
          >
            {error}
            {streamPaused ? " Live updates paused." : ""}
            {streamPaused ? (
              <button
                type="button"
                className="ml-2 underline"
                onClick={() => void load(true)}
              >
                Retry
              </button>
            ) : null}
          </p>
        ) : null}
      </form>

      <section
        className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5"
        aria-labelledby="import-progress-heading"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2
              id="import-progress-heading"
              className="font-[family-name:var(--font-fraunces)] text-xl"
            >
              Import progress
            </h2>
            <p className="mt-0.5 text-xs text-[var(--muted)]">
              Jobs persist in SQLite. Refresh-safe — live updates while active.
              Cancel is cooperative between files/items.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={secondaryButton}
              disabled={actionPending !== null || uploading}
              onClick={() => void load(true)}
            >
              Refresh
            </button>
            {activeJob || pendingJobs.length > 0 ? (
              <button
                type="button"
                className={secondaryButton}
                disabled={
                  actionPending !== null ||
                  Boolean(activeJob?.cancelRequested)
                }
                onClick={() =>
                  void cancelJob(activeJob?.id ?? pendingJobs[0]?.id)
                }
              >
                {activeJob?.cancelRequested
                  ? "Cancelling…"
                  : actionPending === "cancel"
                    ? "Requesting…"
                    : "Cancel"}
              </button>
            ) : null}
          </div>
        </div>

        {!queueBusy ? (
          <p className="mt-4 text-sm text-[var(--muted)]">
            No active or queued imports.{" "}
            <a
              href="#import-history"
              className="text-[var(--ink)] underline decoration-[var(--line)] underline-offset-2 transition hover:decoration-[var(--muted)]"
            >
              View history
            </a>
          </p>
        ) : null}

        {activeJob ? (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${jobStateStyles(activeJob.state)}`}
              >
                {activeJob.state}
              </span>
              <span className="text-[var(--ink)]">{activeJob.filename}</span>
              <span className="text-[var(--muted)]">
                · Phase:{" "}
                <span className="text-[var(--ink)]">
                  {phaseLabel(activeJob.phase)}
                </span>
              </span>
            </div>
            <div>
              <div className="mb-1 flex justify-between text-xs text-[var(--muted)]">
                <span>
                  {activeJob.processed} / {activeJob.total}
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
            <DetailCounts details={activeJob.details} />
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
                    <span className="text-[var(--ink)]">{job.filename}</span>
                  </div>
                  {job.message ? (
                    <p className="text-xs text-[var(--muted)]">{job.message}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    </div>
  );
}
