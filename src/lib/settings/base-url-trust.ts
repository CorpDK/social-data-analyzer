/**
 * Local-first base-URL trust hints (soft UI only — not an allowlist).
 *
 * This app runs as a single-user localhost process. User-configured OpenAI /
 * Ollama base URLs are fetched by that Node process. Loopback and the official
 * OpenAI API host are expected; other hosts get a soft Settings hint so LAN
 * Ollama stays usable without a hard break.
 */

export function parseUrlHostname(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0"
  );
}

/** Official OpenAI API host (default Settings value) — not a trust warning. */
export function isOfficialOpenAiHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "api.openai.com" || host.endsWith(".openai.com");
}

/**
 * Soft Settings hint, or null when the URL looks expected for this provider.
 * Never blocks save — documentation + UI only.
 */
export function baseUrlTrustHint(
  raw: string,
  kind: "openai" | "ollama",
): string | null {
  const host = parseUrlHostname(raw);
  if (!host) return null;
  if (isLoopbackHostname(host)) return null;
  if (kind === "openai" && isOfficialOpenAiHostname(host)) return null;

  if (kind === "ollama") {
    return (
      "Non-local Ollama URL — this app’s Node process will fetch it. " +
      "LAN hosts are fine if you trust that machine (local-first; no SSRF allowlist)."
    );
  }

  return (
    "Custom remote base URL — Node fetches embeddings from this host. " +
    "Only point at services you trust on this machine (see docs/runbook.md)."
  );
}
