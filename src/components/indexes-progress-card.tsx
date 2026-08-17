"use client";

import Link from "next/link";
import type {
  EmbeddingJobDto,
  HostMemoryStatusDto,
} from "@/lib/search/status-dto";

export function jobStateStyles(state: EmbeddingJobDto["state"]): string {
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

export function JobSummaryRow({ job }: { job: EmbeddingJobDto }) {
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

type IndexesProgressCardProps = {
  cardClass: string;
  secondaryButton: string;
  primaryButton: string;
  host: HostMemoryStatusDto | undefined;
  activeJob: EmbeddingJobDto | null;
  pendingJobs: EmbeddingJobDto[];
  queueBusy: boolean;
  pending: string | null;
  actionError: string | null;
  onRefresh: () => void;
  onReindexAll: () => void;
  onCancel: () => void;
};

export function IndexesProgressCard({
  cardClass,
  secondaryButton,
  primaryButton,
  host,
  activeJob,
  pendingJobs,
  queueBusy,
  pending,
  actionError,
  onRefresh,
  onReindexAll,
  onCancel,
}: IndexesProgressCardProps) {
  return (
    <section className={cardClass} aria-labelledby="job-heading">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2
            id="job-heading"
            className="font-[family-name:var(--font-fraunces)] text-lg"
          >
            Reindex progress
          </h2>
          <p className="mt-0.5 text-xs text-[var(--muted)]">
            One job runs at a time; others queue per library+provider. Cancel
            stops only the active job — queued jobs keep their place. Cancel is
            cooperative between items. Interrupted rebuilds resume from
            already-embedded rows. Reindex all configured rebuilds both Saves and
            Likes indexes.
          </p>
          {host?.memAvailableMb != null ? (
            <p className="mt-1 text-[11px] text-[var(--muted)]">
              MemAvailable ~{Math.round(host.memAvailableMb)} MB
              {(() => {
                const critical = host.criticalMinAvailableMb;
                const remote = host.remoteLargeMinAvailableMb;
                if (host.memAvailableMb < critical) {
                  return ` · reindex blocked below ${critical} MB`;
                }
                if (host.memAvailableMb < remote) {
                  return ` · large Voyage/OpenAI/local need ≥${remote} MB; Ollama ≥${host.ollamaLargeMinAvailableMb} MB`;
                }
                if (host.memAvailableMb < host.ollamaLargeMinAvailableMb) {
                  return ` · large Ollama needs ≥${host.ollamaLargeMinAvailableMb} MB`;
                }
                return "";
              })()}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={secondaryButton}
            disabled={pending !== null}
            onClick={onRefresh}
          >
            Refresh
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={pending !== null}
            onClick={onReindexAll}
          >
            {pending === "all-configured" ? "Queueing…" : "Reindex all configured"}
          </button>
          {activeJob ? (
            <button
              type="button"
              className={secondaryButton}
              disabled={pending !== null || Boolean(activeJob.cancelRequested)}
              onClick={onCancel}
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
  );
}
