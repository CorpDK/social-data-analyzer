"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_FILE_LABEL,
  importFileTooLargeMessage,
} from "@/lib/import-limits";

type ImportResponse = {
  status?: "completed" | "duplicate" | "failed";
  message?: string;
  itemsFound?: number;
  itemsAdded?: number;
  itemsUpdated?: number;
  itemsSkipped?: number;
  error?: string;
};

export function UploadForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

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

    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/import", {
        method: "POST",
        body,
      });
      const data = (await response.json()) as ImportResponse;
      if (!response.ok && !data.status) {
        throw new Error(data.error ?? "Import failed");
      }
      setResult(data);
      if (data.status === "completed") {
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
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
          {IMPORT_MAX_FILE_LABEL}. Re-importing newer exports merges new saves
          and skips duplicates by media shortcode.
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
            setResult(null);
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
            busy || !file || (file != null && file.size > IMPORT_MAX_FILE_BYTES)
          }
          className="rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-white transition enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Importing…" : "Import into library"}
        </button>
        <span className="text-sm text-[var(--muted)]">
          Identical files are detected by content hash.
        </span>
      </div>

      {error ? (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}

      {result ? (
        <div
          className={`mt-4 rounded-lg px-4 py-3 text-sm ${
            result.status === "failed"
              ? "bg-red-50 text-[var(--danger)]"
              : result.status === "duplicate"
                ? "bg-amber-50 text-[var(--warn)]"
                : "bg-[var(--accent-soft)] text-[var(--accent)]"
          }`}
        >
          <p className="font-medium">
            {result.message ?? result.error ?? "Done"}
          </p>
          {result.status !== "failed" ? (
            <p className="mt-1 font-[family-name:var(--font-ibm)] text-xs opacity-80">
              found {result.itemsFound ?? 0} · added {result.itemsAdded ?? 0} ·
              updated {result.itemsUpdated ?? 0} · skipped{" "}
              {result.itemsSkipped ?? 0}
            </p>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
