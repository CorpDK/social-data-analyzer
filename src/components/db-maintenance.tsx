"use client";

import { useState } from "react";
import { localMutatingHeaders } from "@/lib/local-mutating-headers";
import type { DbMaintenanceAction } from "@/lib/settings/db-maintenance";
import type { EngineInfo } from "@/lib/storage";

type MaintenanceResponse = {
  ok?: boolean;
  action?: DbMaintenanceAction;
  error?: string;
  walCheckpoint?: { busy: number; log: number; checkpointed: number };
  vacuumMs?: number;
  pageCount?: number;
  freelistCount?: number;
  pageSize?: number;
};

function formatResult(json: MaintenanceResponse): string {
  const pages = json.pageCount ?? 0;
  const free = json.freelistCount ?? 0;
  const pageSize = json.pageSize ?? 0;
  const sizeHint =
    pageSize > 0
      ? ` (~${((pages * pageSize) / (1024 * 1024)).toFixed(1)} MB pages)`
      : "";
  if (json.action === "checkpoint" && json.walCheckpoint) {
    const { busy, log, checkpointed } = json.walCheckpoint;
    return `WAL checkpoint done (busy=${busy}, log=${log}, checkpointed=${checkpointed}). ${pages} pages, ${free} freelist${sizeHint}.`;
  }
  if (json.action === "vacuum") {
    return `VACUUM finished in ${json.vacuumMs ?? 0} ms. ${pages} pages, ${free} freelist${sizeHint}.`;
  }
  return "Maintenance finished.";
}

export function DbMaintenance({ engine }: { engine: EngineInfo }) {
  const [pending, setPending] = useState<DbMaintenanceAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run(action: DbMaintenanceAction) {
    if (pending) return;
    setPending(action);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/settings/db-maintenance", {
        method: "POST",
        headers: localMutatingHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ action }),
      });
      const json = (await response.json()) as MaintenanceResponse;
      if (!response.ok) {
        throw new Error(json.error || "Database maintenance failed");
      }
      setMessage(formatResult(json));
    } catch (runError) {
      setError(
        runError instanceof Error
          ? runError.message
          : "Database maintenance failed",
      );
    } finally {
      setPending(null);
    }
  }

  const secondaryButton =
    "rounded-full border border-[var(--line)] px-3.5 py-1.5 text-xs font-medium text-[var(--muted)] transition hover:border-[var(--muted)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40";
  const primaryButton =
    "rounded-full border border-[var(--accent)]/40 bg-[var(--accent-soft)] px-3.5 py-1.5 text-xs font-medium text-[var(--accent)] transition hover:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <section
      className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 sm:p-5"
      aria-labelledby="db-maintenance-heading"
    >
      <div className="space-y-1.5">
        <h2
          id="db-maintenance-heading"
          className="font-[family-name:var(--font-fraunces)] text-lg"
        >
          Database maintenance
        </h2>
        <p className="max-w-2xl text-sm text-[var(--muted)]">
          Optional housekeeping for a long-lived {engine.displayName} library.{" "}
          {engine.supportsWalCheckpoint
            ? "WAL checkpoint flushes the write-ahead log into the main file. "
            : ""}
          VACUUM reclaims or analyzes storage as supported by the engine. Actions refuse
          (HTTP 409) while an import or reindex is pending or running — cancel
          those jobs first. VACUUM may take a while on large libraries.
        </p>
      </div>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-h-5 text-sm">
          {error ? (
            <p className="text-[var(--danger)]" role="alert">
              {error}
            </p>
          ) : null}
          {message ? (
            <p className="text-[var(--accent)]" role="status">
              {message}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {engine.maintenanceActions.includes("checkpoint") ? (
            <button
              type="button"
              className={secondaryButton}
              disabled={pending !== null}
              onClick={() => void run("checkpoint")}
            >
              {pending === "checkpoint" ? "Checkpointing…" : "WAL checkpoint"}
            </button>
          ) : null}
          <button
            type="button"
            className={primaryButton}
            disabled={pending !== null}
            onClick={() => void run("vacuum")}
          >
            {pending === "vacuum" ? "Vacuuming…" : "VACUUM"}
          </button>
        </div>
      </div>
    </section>
  );
}
