"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { localMutatingHeaders } from "@/lib/local-mutating-headers";

/**
 * Operator recovery: remove catalog rows whose first_seen points at this import.
 */
export function DiscardImportRowsButton({
  importId,
  disabled,
}: {
  importId: number;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function onDiscard() {
    if (
      !window.confirm(
        "Remove saves/likes introduced by this import? Updated-only rows stay; re-import reconciles them.",
      )
    ) {
      return;
    }
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/imports/${importId}/rows`, {
        method: "DELETE",
        headers: localMutatingHeaders(),
      });
      const payload = (await response.json()) as {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      setMessage(payload.message ?? "Rows discarded.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Discard failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="rounded-full border border-[var(--danger)]/50 px-3.5 py-1.5 text-xs font-medium text-[var(--danger)] transition hover:border-[var(--danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
        disabled={disabled || pending}
        onClick={() => void onDiscard()}
      >
        {pending ? "Removing…" : "Remove rows from this import"}
      </button>
      {error ? (
        <p className="text-sm text-[var(--danger)]" role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="text-sm text-[var(--muted)]">{message}</p>
      ) : null}
    </div>
  );
}
