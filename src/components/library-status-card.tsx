"use client";

import { useEffect, useState } from "react";
import { localMutatingHeaders } from "@/lib/local-mutating-headers";
import type { LibraryStatus } from "@/lib/storage";

const COPY = {
  up_to_date: {
    label: "Up to date",
    heading: "Your library is ready",
    body: "Instagram Saves can open your library normally.",
  },
  updating: {
    label: "Updating",
    heading: "Updating your library…",
    body: "This can happen after an app update. Your saved posts are not changed. Leave this window open.",
  },
  generation_break: {
    label: "Library too old",
    heading: "This version of the app can't open your library",
    body: "Copy the library file somewhere safe first, then remove it and import your Instagram download again.",
  },
  apply_failed: {
    label: "Update failed",
    heading: "We couldn't finish updating your library",
    body: "Nothing was deleted. Make a copy of the library file, then try again. If it keeps failing, re-import your Instagram download.",
  },
} as const;

async function readResponse(response: Response): Promise<LibraryStatus> {
  const json = (await response.json()) as LibraryStatus & { error?: string };
  if (!response.ok) {
    throw new Error(json.error || "The library update could not be retried.");
  }
  return json;
}

export function LibraryStatusCard({
  initialStatus,
  showTechnicalDetails = false,
}: {
  initialStatus: LibraryStatus;
  showTechnicalDetails?: boolean;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const copy = COPY[status.state];

  useEffect(() => {
    if (status.state !== "updating") return;
    const timer = window.setInterval(async () => {
      try {
        const next = await readResponse(
          await fetch("/api/settings/library-status", { cache: "no-store" }),
        );
        setStatus(next);
      } catch {
        // Keep the calm updating state while startup work is still blocking.
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [status.state]);

  async function retry() {
    setRetrying(true);
    setRetryError(null);
    try {
      const next = await readResponse(
        await fetch("/api/settings/library-status", {
          method: "POST",
          headers: localMutatingHeaders(),
        }),
      );
      setStatus(next);
    } catch (error) {
      setRetryError(
        error instanceof Error
          ? error.message
          : "The library update could not be retried.",
      );
    } finally {
      setRetrying(false);
    }
  }

  const needsBackup =
    status.state === "generation_break" || status.state === "apply_failed";

  return (
    <section
      className="space-y-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 sm:p-5"
      aria-labelledby="library-status-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
            Library status
          </p>
          <h2
            id="library-status-heading"
            className="mt-1 font-[family-name:var(--font-fraunces)] text-xl"
          >
            {copy.heading}
          </h2>
        </div>
        <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-xs font-medium text-[var(--accent)]">
          {copy.label}
        </span>
      </div>

      <p className="text-sm text-[var(--muted)]">{copy.body}</p>
      <dl className="grid gap-2 text-sm sm:grid-cols-[8rem_1fr]">
        <dt className="text-[var(--muted)]">Stored with</dt>
        <dd>{status.displayName}</dd>
        <dt className="text-[var(--muted)]">File location</dt>
        <dd className="break-all font-[family-name:var(--font-ibm)] text-xs">
          {status.locationFolder ?? status.location}
        </dd>
      </dl>

      {needsBackup && status.engine === "sqlite" ? (
        <p className="rounded-xl border border-[var(--warn)]/40 px-3 py-2 text-sm">
          Quit the app before making a backup. Copy the library file
          <span className="font-[family-name:var(--font-ibm)]"> {status.location}</span>
          {" "}and the two sidecar files if you see them into another folder.
        </p>
      ) : null}

      {status.state === "apply_failed" ? (
        <button
          type="button"
          onClick={() => void retry()}
          disabled={retrying}
          className="control-active rounded-full px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {retrying ? "Trying again…" : "Try again"}
        </button>
      ) : null}

      {retryError ? (
        <p className="text-sm text-[var(--danger)]" role="alert">
          {retryError}
        </p>
      ) : null}

      {showTechnicalDetails && status.technicalDetail ? (
        <details className="text-xs text-[var(--muted)]">
          <summary className="cursor-pointer">Technical details</summary>
          <p className="mt-2 break-words font-[family-name:var(--font-ibm)]">
            {status.technicalDetail}
          </p>
        </details>
      ) : null}
    </section>
  );
}
