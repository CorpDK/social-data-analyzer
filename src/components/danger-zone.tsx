"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { localMutatingHeaders } from "@/lib/local-mutating-headers";
import { RESET_LIBRARY_CONFIRMATION_PHRASE } from "@/lib/settings/reset-phrase";

type Step = "closed" | "phrase" | "confirm";

export function DangerZone() {
  const [step, setStep] = useState<Step>("closed");
  const [phrase, setPhrase] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const phraseInputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const descId = useId();

  const phraseMatches = phrase === RESET_LIBRARY_CONFIRMATION_PHRASE;

  const closeDialog = useCallback(() => {
    setStep("closed");
    setPhrase("");
    setPending(false);
    dialogRef.current?.close();
  }, []);

  const openPhraseStep = useCallback(() => {
    setError(null);
    setMessage(null);
    setPhrase("");
    setStep("phrase");
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (step === "closed") {
      if (dialog.open) dialog.close();
      return;
    }

    if (!dialog.open) dialog.showModal();

    if (step === "phrase") {
      // Defer so the dialog is painted before focusing.
      requestAnimationFrame(() => phraseInputRef.current?.focus());
    }
  }, [step]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    function onCancel(event: Event) {
      event.preventDefault();
      closeDialog();
    }

    dialog.addEventListener("cancel", onCancel);
    return () => dialog.removeEventListener("cancel", onCancel);
  }, [closeDialog]);

  function onPhraseContinue(event: FormEvent) {
    event.preventDefault();
    if (!phraseMatches || pending) return;
    setStep("confirm");
  }

  async function onFinalConfirm() {
    if (pending) return;
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/settings/reset-library", {
        method: "POST",
        headers: localMutatingHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          confirmation: RESET_LIBRARY_CONFIRMATION_PHRASE,
        }),
      });
      const json = (await response.json()) as {
        error?: string;
        wiped?: { savedItems: number; imports: number };
      };
      if (!response.ok) {
        throw new Error(json.error || "Failed to reset library");
      }
      closeDialog();
      const items = json.wiped?.savedItems ?? 0;
      const imports = json.wiped?.imports ?? 0;
      setMessage(
        `Library reset. Removed ${items} save${items === 1 ? "" : "s"} and ${imports} import${imports === 1 ? "" : "s"}. Settings and API keys were kept.`,
      );
    } catch (resetError) {
      setError(
        resetError instanceof Error
          ? resetError.message
          : "Failed to reset library",
      );
      setStep("phrase");
      setPending(false);
    }
  }

  function onDialogKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
    }
  }

  const secondaryButton =
    "rounded-full border border-[var(--line)] px-3.5 py-1.5 text-xs font-medium text-[var(--muted)] transition hover:border-[var(--muted)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40";
  const dangerButton =
    "rounded-full border border-[var(--danger)]/50 bg-[var(--danger)]/10 px-3.5 py-1.5 text-xs font-medium text-[var(--danger)] transition hover:bg-[var(--danger)]/18 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--danger)] disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <section
      className="rounded-2xl border border-[var(--danger)]/35 bg-[var(--surface)] p-4 sm:p-5"
      aria-labelledby="danger-zone-heading"
    >
      <div className="space-y-1.5">
        <h2
          id="danger-zone-heading"
          className="font-[family-name:var(--font-fraunces)] text-lg text-[var(--danger)]"
        >
          Danger zone
        </h2>
        <p className="max-w-2xl text-sm text-[var(--muted)]">
          Permanently delete every imported save, collection link, import
          history, and search index. This cannot be undone. Your Settings
          (models, URLs, preferred provider) and system keyring API keys are
          kept. This is a local single-user app — the typed confirmation phrase
          is the safeguard, not multi-user auth. Reset is blocked (HTTP 409)
          while an import or reindex job is pending or running — cancel those
          first.
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
        <button
          type="button"
          className={dangerButton}
          onClick={openPhraseStep}
          disabled={pending}
        >
          Delete all saves…
        </button>
      </div>

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={descId}
        onKeyDown={onDialogKeyDown}
        className="m-auto w-[min(100%,28rem)] rounded-2xl border border-[var(--danger)]/40 bg-[var(--surface)] p-0 text-[var(--ink)] shadow-xl backdrop:bg-black/45 open:flex open:flex-col"
      >
        {step === "phrase" ? (
          <form onSubmit={onPhraseContinue} className="space-y-4 p-5">
            <div className="space-y-1.5">
              <h3
                id={titleId}
                className="font-[family-name:var(--font-fraunces)] text-xl text-[var(--danger)]"
              >
                Confirm library reset
              </h3>
              <p id={descId} className="text-sm text-[var(--muted)]">
                This irreversibly wipes all saves, imports, and search indexes.
                Type{" "}
                <code className="rounded bg-[var(--chip)] px-1.5 py-0.5 font-[family-name:var(--font-ibm)] text-[12px] text-[var(--danger)]">
                  {RESET_LIBRARY_CONFIRMATION_PHRASE}
                </code>{" "}
                to continue.
              </p>
            </div>
            <label className="block space-y-1.5 text-sm">
              <span className="text-[var(--muted)]">Confirmation phrase</span>
              <input
                ref={phraseInputRef}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={phrase}
                onChange={(event) => setPhrase(event.target.value)}
                className="w-full rounded-lg border border-[var(--line)] bg-[var(--bg)] px-3 py-2 font-[family-name:var(--font-ibm)] text-[13px] text-[var(--ink)] outline-none transition focus-visible:border-[var(--danger)] focus-visible:ring-2 focus-visible:ring-[var(--danger)]/35"
                aria-invalid={phrase.length > 0 && !phraseMatches}
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={secondaryButton}
                onClick={closeDialog}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={dangerButton}
                disabled={!phraseMatches || pending}
              >
                Continue
              </button>
            </div>
          </form>
        ) : null}

        {step === "confirm" ? (
          <div className="space-y-4 p-5">
            <div className="space-y-1.5">
              <h3
                id={titleId}
                className="font-[family-name:var(--font-fraunces)] text-xl text-[var(--danger)]"
              >
                Are you sure?
              </h3>
              <p id={descId} className="text-sm text-[var(--muted)]">
                Last chance. All Instagram saves and search indexes will be
                deleted permanently. Settings and API keys stay.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={secondaryButton}
                onClick={closeDialog}
                disabled={pending}
                autoFocus
              >
                Cancel
              </button>
              <button
                type="button"
                className={dangerButton}
                onClick={() => void onFinalConfirm()}
                disabled={pending}
              >
                {pending ? "Deleting…" : "Yes, delete everything"}
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </section>
  );
}
