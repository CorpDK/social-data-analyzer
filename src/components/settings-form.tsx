"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { baseUrlTrustHint } from "@/lib/settings/base-url-trust";

type SecretStatus = {
  configured: boolean;
  source: "keyring" | "env" | null;
};

type PreferredProvider = "local" | "ollama" | "openai" | "voyage";
type SecretField = "openaiApiKey" | "voyageApiKey" | "ollamaApiKey";
type LibraryEnables = { saves: boolean; likes: boolean };

type SettingsPayload = {
  keyring: {
    available: boolean;
    backend: "native" | "memory" | "unavailable";
    message: string | null;
  };
  preferredProvider: PreferredProvider | null;
  timeoutMs: number;
  local: { enabled: LibraryEnables };
  openai: SecretStatus & { enabled: LibraryEnables; baseUrl: string; model: string };
  voyage: SecretStatus & { enabled: LibraryEnables; model: string };
  ollama: SecretStatus & {
    enabled: LibraryEnables;
    baseUrl: string;
    model: string;
    available: boolean;
  };
};

function statusLabel(status: SecretStatus | undefined) {
  if (!status) return "Loading";
  if (!status.configured) return "Not configured";
  if (status.source === "keyring") return "Saved in keyring";
  if (status.source === "env") return "From environment";
  return "Configured";
}

export function SettingsForm() {
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const [preferredProvider, setPreferredProvider] = useState("");
  const [timeoutMs, setTimeoutMs] = useState("10000");
  const [openaiKey, setOpenaiKey] = useState("");
  const [voyageKey, setVoyageKey] = useState("");
  const [ollamaKey, setOllamaKey] = useState("");
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState("https://api.openai.com/v1");
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState("http://127.0.0.1:11434/v1");
  const [openaiModel, setOpenaiModel] = useState("text-embedding-3-small");
  const [voyageModel, setVoyageModel] = useState("voyage-4-lite");
  const [ollamaModel, setOllamaModel] = useState("qwen3-embedding:0.6b");
  const [localEnabled, setLocalEnabled] = useState<LibraryEnables>({
    saves: true,
    likes: true,
  });
  const [openaiEnabled, setOpenaiEnabled] = useState<LibraryEnables>({
    saves: false,
    likes: false,
  });
  const [voyageEnabled, setVoyageEnabled] = useState<LibraryEnables>({
    saves: false,
    likes: false,
  });
  const [ollamaEnabled, setOllamaEnabled] = useState<LibraryEnables>({
    saves: false,
    likes: false,
  });

  const applyPayload = useCallback((json: SettingsPayload) => {
    setData(json);
    setPreferredProvider(json.preferredProvider ?? "");
    setTimeoutMs(String(json.timeoutMs));
    setOpenaiBaseUrl(json.openai.baseUrl);
    setOpenaiModel(json.openai.model);
    setVoyageModel(json.voyage.model);
    setOllamaBaseUrl(json.ollama.baseUrl);
    setOllamaModel(json.ollama.model);
    setLocalEnabled(json.local.enabled);
    setOpenaiEnabled(json.openai.enabled);
    setVoyageEnabled(json.voyage.enabled);
    setOllamaEnabled(json.ollama.enabled);
    setOpenaiKey("");
    setVoyageKey("");
    setOllamaKey("");
  }, []);

  const load = useCallback(async () => {
    setPending("refresh");
    try {
      const response = await fetch("/api/settings/keys");
      if (!response.ok) throw new Error("Failed to load settings");
      applyPayload((await response.json()) as SettingsPayload);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load settings");
    } finally {
      setPending(null);
    }
  }, [applyPayload]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/settings/keys");
        if (!response.ok || cancelled) return;
        const json = (await response.json()) as SettingsPayload;
        if (!cancelled) applyPayload(json);
      } catch {
        if (!cancelled) setError("Failed to load settings");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyPayload]);

  async function update(
    body: Record<string, string | number | boolean | LibraryEnables>,
  ) {
    const response = await fetch("/api/settings/keys", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as SettingsPayload & { error?: string };
    if (!response.ok) throw new Error(json.error || "Failed to save settings");
    applyPayload(json);
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    setPending("settings");
    setError(null);
    setMessage(null);
    try {
      const parsedTimeout = Number(timeoutMs);
      if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
        throw new Error("Timeout must be a positive number of milliseconds");
      }
      await update({
        preferredProvider,
        timeoutMs: Math.round(parsedTimeout),
        openaiBaseUrl,
        openaiModel,
        voyageModel,
        ollamaBaseUrl,
        ollamaModel,
        localEnabled,
        openaiEnabled,
        voyageEnabled,
        ollamaEnabled,
      });
      setMessage("Search, index, model, and connection settings saved.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save settings");
    } finally {
      setPending(null);
    }
  }

  async function changeSecret(
    field: SecretField,
    value: string,
    provider: string,
  ) {
    if (value !== "" && !value.trim()) return;
    setPending(field);
    setError(null);
    setMessage(null);
    try {
      await update({ [field]: value.trim() });
      setMessage(
        value
          ? `${provider} credential saved in the system keyring. Enable the index separately below if you want to use it.`
          : `${provider} keyring entry cleared.`,
      );
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to update credential");
    } finally {
      setPending(null);
    }
  }

  const fieldClass =
    "w-full rounded-lg border border-[var(--line)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--ink)] outline-none transition placeholder:text-[var(--muted)]/65 focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]/35";
  const monoFieldClass = `${fieldClass} font-[family-name:var(--font-ibm)] text-[13px]`;
  const cardClass =
    "rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 sm:p-5";
  const labelClass = "block space-y-1.5 text-sm";
  const secondaryButton =
    "rounded-full border border-[var(--line)] px-3 py-1.5 text-xs font-medium text-[var(--muted)] transition hover:border-[var(--muted)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40";
  const primaryButton =
    "control-active rounded-full px-3.5 py-1.5 text-xs font-medium transition hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:cursor-not-allowed disabled:opacity-40";

  const credentials = [
    {
      provider: "OpenAI",
      field: "openaiApiKey" as const,
      status: data?.openai,
      value: openaiKey,
      setValue: setOpenaiKey,
      placeholder: "sk-…",
    },
    {
      provider: "Voyage",
      field: "voyageApiKey" as const,
      status: data?.voyage,
      value: voyageKey,
      setValue: setVoyageKey,
      placeholder: "pa-…",
    },
    {
      provider: "Ollama",
      field: "ollamaApiKey" as const,
      status: data?.ollama,
      value: ollamaKey,
      setValue: setOllamaKey,
      placeholder: "Optional bearer token",
    },
  ];

  const indexRows = [
    {
      id: "local",
      label: "Local (basic)",
      hint: "Offline feature-hash vectors. FTS keyword search always stays on.",
      enabled: localEnabled,
      setEnabled: setLocalEnabled,
    },
    {
      id: "openai",
      label: "OpenAI",
      hint: "Requires an OpenAI API key. Saving a key does not turn this on.",
      enabled: openaiEnabled,
      setEnabled: setOpenaiEnabled,
    },
    {
      id: "voyage",
      label: "Voyage",
      hint: "Requires a Voyage API key. Saving a key does not turn this on.",
      enabled: voyageEnabled,
      setEnabled: setVoyageEnabled,
    },
    {
      id: "ollama",
      label: "Ollama",
      hint: "Requires a running Ollama with the selected model pulled.",
      enabled: ollamaEnabled,
      setEnabled: setOllamaEnabled,
    },
  ];

  function setLibraryEnable(
    setEnabled: (next: LibraryEnables) => void,
    current: LibraryEnables,
    library: keyof LibraryEnables,
    checked: boolean,
  ) {
    setEnabled({ ...current, [library]: checked });
  }

  const openaiUrlHint = baseUrlTrustHint(openaiBaseUrl, "openai");
  const ollamaUrlHint = baseUrlTrustHint(ollamaBaseUrl, "ollama");

  return (
    <form onSubmit={saveSettings} className="space-y-4">
      {data?.keyring.message ? (
        <p
          className={`rounded-xl border px-3.5 py-2 text-xs ${
            data.keyring.available
              ? "border-[var(--line)] bg-[var(--surface)] text-[var(--muted)]"
              : "border-[var(--warn)]/40 bg-[var(--surface)] text-[var(--warn)]"
          }`}
          role="status"
        >
          {data.keyring.message}
        </p>
      ) : null}

      <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
        <section className={`${cardClass} order-1 space-y-3`} aria-labelledby="search-defaults-heading">
          <div>
            <h2 id="search-defaults-heading" className="font-[family-name:var(--font-fraunces)] text-lg">
              Search defaults
            </h2>
            <p className="mt-0.5 text-xs text-[var(--muted)]">Provider choice and remote request limit.</p>
          </div>
          <label className={labelClass}>
            <span className="text-[var(--muted)]">Preferred provider</span>
            <select
              name="preferredProvider"
              value={preferredProvider}
              onChange={(event) => setPreferredProvider(event.target.value)}
              className={fieldClass}
            >
              <option value="">Auto (OpenAI → Voyage → Ollama → Local)</option>
              <option value="local">Local (basic)</option>
              <option value="ollama">Ollama</option>
              <option value="openai">OpenAI</option>
              <option value="voyage">Voyage</option>
            </select>
          </label>
          <label className={labelClass}>
            <span className="text-[var(--muted)]">Remote timeout (milliseconds)</span>
            <input
              type="number"
              min={1}
              step={1}
              name="timeoutMs"
              value={timeoutMs}
              onChange={(event) => setTimeoutMs(event.target.value)}
              className={monoFieldClass}
            />
          </label>
        </section>

        <section
          className={`${cardClass} order-2 space-y-3 md:col-span-2 xl:col-span-2`}
          aria-labelledby="indexes-heading"
        >
          <div>
            <h2 id="indexes-heading" className="font-[family-name:var(--font-fraunces)] text-lg">
              Indexes
            </h2>
            <p className="mt-0.5 text-xs text-[var(--muted)]">
              Enable each provider for Saves, Likes, or both. API keys and URLs alone do not activate search or reindex.
            </p>
          </div>
          <div className="overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--bg)]/45">
            <table className="w-full min-w-[22rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--line)] text-left text-xs text-[var(--muted)]">
                  <th scope="col" className="px-3 py-2 font-medium">
                    Provider
                  </th>
                  <th scope="col" className="w-20 px-3 py-2 text-center font-medium">
                    Saves
                  </th>
                  <th scope="col" className="w-20 px-3 py-2 text-center font-medium">
                    Likes
                  </th>
                </tr>
              </thead>
              <tbody>
                {indexRows.map((row) => (
                  <tr key={row.id} className="border-b border-[var(--line)]/70 last:border-b-0">
                    <th scope="row" className="px-3 py-2.5 text-left font-normal">
                      <span className="block font-medium">{row.label}</span>
                      <span className="block text-xs text-[var(--muted)]">{row.hint}</span>
                    </th>
                    <td className="px-3 py-2.5 text-center">
                      <input
                        type="checkbox"
                        name={`${row.id}EnabledSaves`}
                        aria-label={`Enable ${row.label} for Saves`}
                        checked={row.enabled.saves}
                        onChange={(event) =>
                          setLibraryEnable(
                            row.setEnabled,
                            row.enabled,
                            "saves",
                            event.target.checked,
                          )
                        }
                        className="size-4 accent-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                      />
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <input
                        type="checkbox"
                        name={`${row.id}EnabledLikes`}
                        aria-label={`Enable ${row.label} for Likes`}
                        checked={row.enabled.likes}
                        onChange={(event) =>
                          setLibraryEnable(
                            row.setEnabled,
                            row.enabled,
                            "likes",
                            event.target.checked,
                          )
                        }
                        className="size-4 accent-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className={`${cardClass} order-3 space-y-3 md:col-span-2 xl:order-4 xl:col-span-3`} aria-labelledby="credentials-heading">
          <div>
            <h2 id="credentials-heading" className="font-[family-name:var(--font-fraunces)] text-lg">
              API keys & credentials
            </h2>
            <p className="mt-0.5 text-xs text-[var(--muted)]">
              Saved separately to your system keyring. Stored values are never returned. Saving a key does not enable the index.
            </p>
          </div>
          <div className="grid gap-3 lg:grid-cols-3">
            {credentials.map((credential) => {
              const canClear =
                credential.status?.configured && credential.status.source === "keyring";
              return (
                <div key={credential.field} className="space-y-2 rounded-xl border border-[var(--line)]/80 bg-[var(--bg)]/45 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor={credential.field} className="text-sm font-medium">
                      {credential.provider}
                    </label>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      credential.status?.configured
                        ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                        : "bg-[var(--chip)] text-[var(--muted)]"
                    }`}>
                      {statusLabel(credential.status)}
                    </span>
                  </div>
                  <input
                    id={credential.field}
                    type="password"
                    autoComplete="new-password"
                    name={credential.field}
                    value={credential.value}
                    onChange={(event) => credential.setValue(event.target.value)}
                    placeholder={credential.status?.configured ? "•••••••• (enter to replace)" : credential.placeholder}
                    className={fieldClass}
                    disabled={!data?.keyring.available}
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className={primaryButton}
                      disabled={!credential.value.trim() || pending !== null || !data?.keyring.available}
                      onClick={() => void changeSecret(credential.field, credential.value, credential.provider)}
                    >
                      {pending === credential.field ? "Saving…" : "Save key"}
                    </button>
                    <button
                      type="button"
                      className={secondaryButton}
                      disabled={!canClear || pending !== null}
                      onClick={() => void changeSecret(credential.field, "", credential.provider)}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className={`${cardClass} order-4 space-y-3 xl:order-3`} aria-labelledby="models-heading">
          <div>
            <h2 id="models-heading" className="font-[family-name:var(--font-fraunces)] text-lg">Models</h2>
            <p className="mt-0.5 text-xs text-[var(--muted)]">Embedding model identifiers by provider.</p>
          </div>
          <label className={labelClass}>
            <span className="text-[var(--muted)]">OpenAI model</span>
            <input name="openaiModel" value={openaiModel} onChange={(event) => setOpenaiModel(event.target.value)} className={monoFieldClass} />
          </label>
          <label className={labelClass}>
            <span className="text-[var(--muted)]">Voyage model</span>
            <input name="voyageModel" value={voyageModel} onChange={(event) => setVoyageModel(event.target.value)} className={monoFieldClass} />
          </label>
          <label className={labelClass}>
            <span className="text-[var(--muted)]">Ollama model</span>
            <input name="ollamaModel" value={ollamaModel} onChange={(event) => setOllamaModel(event.target.value)} className={monoFieldClass} />
          </label>
        </section>

        <section className={`${cardClass} order-5 space-y-3 xl:order-5`} aria-labelledby="endpoints-heading">
          <div>
            <h2 id="endpoints-heading" className="font-[family-name:var(--font-fraunces)] text-lg">Endpoints</h2>
            <p className="mt-0.5 text-xs text-[var(--muted)]">OpenAI-compatible service connections.</p>
          </div>
          <label className={labelClass}>
            <span className="text-[var(--muted)]">OpenAI base URL</span>
            <input type="url" name="openaiBaseUrl" value={openaiBaseUrl} onChange={(event) => setOpenaiBaseUrl(event.target.value)} className={monoFieldClass} />
            {openaiUrlHint ? (
              <p className="mt-1 text-xs text-[var(--muted)]" role="note">
                {openaiUrlHint}
              </p>
            ) : null}
          </label>
          <label className={labelClass}>
            <span className="text-[var(--muted)]">Ollama base URL</span>
            <input type="url" name="ollamaBaseUrl" value={ollamaBaseUrl} onChange={(event) => setOllamaBaseUrl(event.target.value)} className={monoFieldClass} />
            {ollamaUrlHint ? (
              <p className="mt-1 text-xs text-[var(--muted)]" role="note">
                {ollamaUrlHint}
              </p>
            ) : null}
          </label>
        </section>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-h-5 text-sm">
          {error ? <p className="text-[var(--danger)]" role="alert">{error}</p> : null}
          {message ? <p className="text-[var(--accent)]" role="status">{message}</p> : null}
          {!error && !message ? <p className="text-xs text-[var(--muted)]">Changes to non-secret settings apply after saving.</p> : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" disabled={pending !== null} onClick={() => void load()} className={secondaryButton}>
            {pending === "refresh" ? "Refreshing…" : "Refresh"}
          </button>
          <button type="submit" disabled={pending !== null || !data} className={primaryButton}>
            {pending === "settings" ? "Saving…" : "Save settings"}
          </button>
        </div>
      </div>

      {data && !data.keyring.available ? (
        <p className="text-xs text-[var(--muted)]">
          API key fields are disabled because the system keyring is unavailable. Set secrets with environment variables; all other settings can still be saved.
        </p>
      ) : null}
    </form>
  );
}
