"use client";

import { useState } from "react";
import { localMutatingHeaders } from "@/lib/local-mutating-headers";
import { StorageEngineSwitcher } from "./storage-engine-switcher";

export function AdvancedStorage({
  initialEnabled,
  lockedByEnvironment,
}: {
  initialEnabled: boolean;
  lockedByEnvironment: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: boolean) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/settings/advanced-storage", {
        method: "POST",
        headers: localMutatingHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ enabled: next }),
      });
      if (!response.ok) {
        const json = (await response.json()) as { error?: string };
        throw new Error(json.error || "Advanced storage could not be changed.");
      }
      setEnabled(next);
    } catch (changeError) {
      setError(
        changeError instanceof Error
          ? changeError.message
          : "Advanced storage could not be changed.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="space-y-3" aria-labelledby="advanced-storage-heading">
      <div>
        <p className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
          Advanced storage
        </p>
        <h2
          id="advanced-storage-heading"
          className="mt-1 font-[family-name:var(--font-fraunces)] text-xl"
        >
          Run your own database
        </h2>
      </div>
      <label className="flex items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          disabled={pending || lockedByEnvironment}
          onChange={(event) => void change(event.target.checked)}
          className="mt-1"
        />
        <span>
          <span className="block font-medium">
            I run my own PostgreSQL server
          </span>
          <span className="text-[var(--muted)]">
            Only turn this on if you already manage PostgreSQL yourself.
          </span>
        </span>
      </label>
      {lockedByEnvironment ? (
        <p className="text-xs text-[var(--muted)]">
          Advanced storage is enabled by this app&apos;s environment.
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-[var(--danger)]" role="alert">
          {error}
        </p>
      ) : null}
      {enabled ? <StorageEngineSwitcher /> : null}
    </section>
  );
}
