"use client";

import { useCallback, useEffect, useState } from "react";
import { localMutatingHeaders } from "@/lib/local-mutating-headers";
import { useJobSse } from "@/lib/use-job-sse";

type Engine = "sqlite" | "postgres";

type EngineJob = {
  state: "idle" | "running" | "completed" | "failed";
  action: "migrate" | "fresh" | null;
  sourceEngine: Engine;
  targetEngine: Engine | null;
  phase: string;
  percent: number;
  message: string;
  error: string | null;
  rowsCopied: number;
};

type EngineStatus = {
  current: {
    engine: Engine;
    displayName: string;
    sqlitePath: string;
    postgresUrl: string | null;
    source: "settings" | "environment";
  };
  postgresMigration: "absent" | "in_progress" | "complete" | "unreachable";
  startupError: string | null;
  job: EngineJob;
  freshConfirmation: string;
};

async function responseJson<T>(response: Response): Promise<T> {
  const json = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(json.error || "Storage engine request failed.");
  }
  return json;
}

export function StorageEngineSwitcher() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [job, setJob] = useState<EngineJob | null>(null);
  const [postgresUrl, setPostgresUrl] = useState("");
  const [sqlitePath, setSqlitePath] = useState("");
  const [freshOpen, setFreshOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await responseJson<EngineStatus>(
        await fetch("/api/settings/storage-engine", { cache: "no-store" }),
      );
      setStatus(next);
      setJob(next.job);
      setSqlitePath((current) => current || next.current.sqlitePath);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load engine status.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useJobSse({
    url: "/api/settings/storage-engine/stream",
    enabled: job?.state === "running",
    onSnapshot: (snapshot) => {
      const next = snapshot as EngineJob;
      setJob(next);
      if (next.state !== "running") void load();
    },
    onIdle: () => void load(),
    onStreamError: setError,
  });

  if (!status) {
    return (
      <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 sm:p-5">
        <h2 className="font-[family-name:var(--font-fraunces)] text-lg">Storage engine</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">{error ?? "Loading storage status…"}</p>
      </section>
    );
  }

  const targetEngine: Engine =
    status.current.engine === "sqlite" ? "postgres" : "sqlite";
  const targetLabel = targetEngine === "postgres" ? "PostgreSQL" : "SQLite";
  const running = job?.state === "running";

  async function start(action: "migrate" | "fresh") {
    setPending(true);
    setError(null);
    try {
      const body = {
        action,
        engine: targetEngine,
        postgresUrl: targetEngine === "postgres" ? postgresUrl : undefined,
        sqlitePath: targetEngine === "sqlite" ? sqlitePath : undefined,
        confirmation: action === "fresh" ? confirmation : undefined,
      };
      const result = await responseJson<{ job: EngineJob }>(
        await fetch("/api/settings/storage-engine", {
          method: "POST",
          headers: localMutatingHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(body),
        }),
      );
      setJob(result.job);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Failed to start engine switch.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className="space-y-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 sm:p-5"
      aria-labelledby="storage-engine-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="storage-engine-heading" className="font-[family-name:var(--font-fraunces)] text-lg">
            Storage engine
          </h2>
          <p className="mt-0.5 text-xs text-[var(--muted)]">
            Active: {status.current.displayName}. Switching to {targetLabel} migrates your existing library by default.
          </p>
        </div>
        <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-xs font-medium text-[var(--accent)]">
          {status.current.displayName}
        </span>
      </div>

      {status.postgresMigration === "in_progress" ? (
        <p className="rounded-xl border border-[var(--danger)]/40 bg-[var(--danger)]/5 px-3 py-2 text-sm text-[var(--danger)]" role="alert">
          This PostgreSQL database has an incomplete migration and is blocked from app use. Re-run the same offline migration, or recreate the database before selecting it again.
        </p>
      ) : null}
      {status.startupError ? (
        <p className="rounded-xl border border-[var(--warn)]/40 px-3 py-2 text-sm text-[var(--warn)]" role="alert">
          {status.startupError}
        </p>
      ) : null}

      <label className="block space-y-1.5 text-sm">
        <span className="text-[var(--muted)]">
          {targetEngine === "postgres" ? "PostgreSQL connection URL" : "New SQLite file path"}
        </span>
        <input
          type={targetEngine === "postgres" ? "password" : "text"}
          value={targetEngine === "postgres" ? postgresUrl : sqlitePath}
          onChange={(event) =>
            targetEngine === "postgres"
              ? setPostgresUrl(event.target.value)
              : setSqlitePath(event.target.value)
          }
          placeholder={
            targetEngine === "postgres"
              ? "postgres://user:password@127.0.0.1:5432/instagram_saves_new"
              : "/absolute/path/to/new-instagram-saves.db"
          }
          disabled={running || pending}
          className="w-full rounded-lg border border-[var(--line)] bg-[var(--bg)] px-3 py-2 font-[family-name:var(--font-ibm)] text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
        />
      </label>

      {job && job.state !== "idle" ? (
        <div className="space-y-2 rounded-xl border border-[var(--line)] bg-[var(--bg)]/45 p-3" aria-live="polite">
          <div className="flex justify-between gap-3 text-xs">
            <span className="font-medium capitalize">{job.phase.replaceAll("_", " ")}</span>
            <span className="text-[var(--muted)]">{job.percent}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-[var(--chip)]">
            <div className="h-full rounded-full bg-[var(--accent)] transition-[width]" style={{ width: `${job.percent}%` }} />
          </div>
          <p className="text-xs text-[var(--muted)]">{job.error ?? job.message}</p>
        </div>
      ) : null}

      {error ? <p className="text-sm text-[var(--danger)]" role="alert">{error}</p> : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void start("migrate")}
          disabled={running || pending || (targetEngine === "postgres" ? !postgresUrl.trim() : !sqlitePath.trim())}
          className="control-active rounded-full px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40"
        >
          {running && job?.action === "migrate" ? "Migrating…" : `Migrate library to ${targetLabel}`}
        </button>
        <button
          type="button"
          onClick={() => setFreshOpen((open) => !open)}
          disabled={running || pending}
          className="rounded-full border border-[var(--line)] px-4 py-2 text-sm text-[var(--muted)] disabled:opacity-40"
        >
          Switch empty / start fresh
        </button>
      </div>

      {freshOpen ? (
        <div className="space-y-3 rounded-xl border border-[var(--warn)]/40 p-3">
          <p className="text-xs text-[var(--muted)]">
            Optional: activate an unused, empty {targetLabel} target without copying this library. Your current library remains untouched for switching back later.
          </p>
          <label className="block space-y-1 text-xs">
            <span>Type <strong>{status.freshConfirmation}</strong> to confirm</span>
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              className="w-full rounded-lg border border-[var(--line)] bg-[var(--bg)] px-3 py-2"
            />
          </label>
          <button
            type="button"
            onClick={() => void start("fresh")}
            disabled={pending || running || confirmation !== status.freshConfirmation}
            className="rounded-full border border-[var(--warn)] px-3.5 py-1.5 text-xs font-medium text-[var(--warn)] disabled:opacity-40"
          >
            Confirm empty switch
          </button>
        </div>
      ) : null}
    </section>
  );
}
