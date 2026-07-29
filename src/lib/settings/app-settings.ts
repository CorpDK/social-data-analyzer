import type Database from "better-sqlite3";
import { getSqlite } from "../db";

export type PreferredProvider = "local" | "ollama" | "openai" | "voyage";

export type AppSettingKey =
  | "local_enabled"
  | "ollama_base_url"
  | "ollama_embedding_model"
  | "ollama_enabled"
  | "openai_enabled"
  | "voyage_enabled"
  | "embedding_provider"
  | "openai_base_url"
  | "openai_embedding_model"
  | "voyage_model"
  | "embedding_timeout_ms";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";
const DEFAULT_VOYAGE_MODEL = "voyage-4-lite";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_OLLAMA_MODEL = "qwen3-embedding:0.6b";
const DEFAULT_TIMEOUT_MS = 10_000;

const PROVIDER_VALUES = new Set<PreferredProvider>([
  "local",
  "ollama",
  "openai",
  "voyage",
]);

export function ensureAppSettingsTable(
  sqlite: Database.Database = getSqlite(),
) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
}

export function getAppSetting(
  key: AppSettingKey,
  sqlite: Database.Database = getSqlite(),
): string | null {
  ensureAppSettingsTable(sqlite);
  const row = sqlite
    .prepare(`SELECT value FROM app_settings WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  const value = row?.value?.trim();
  return value ? value : null;
}

export function setAppSetting(
  key: AppSettingKey,
  value: string | null,
  sqlite: Database.Database = getSqlite(),
) {
  ensureAppSettingsTable(sqlite);
  if (value === null || value.trim() === "") {
    sqlite.prepare(`DELETE FROM app_settings WHERE key = ?`).run(key);
    return;
  }
  sqlite
    .prepare(
      `INSERT INTO app_settings(key, value, updated_at)
       VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = unixepoch()`,
    )
    .run(key, value.trim());
}

function firstNonEmpty(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) return value;
  }
  return null;
}

function parseProvider(raw: string | null | undefined): PreferredProvider | null {
  const value = raw?.trim().toLowerCase();
  if (value && PROVIDER_VALUES.has(value as PreferredProvider)) {
    return value as PreferredProvider;
  }
  return null;
}

/**
 * Explicit enable flags in app_settings. Credentials alone never enable an index.
 * Defaults: local on; openai / voyage / ollama off.
 * Env `*_ENABLED=1|0` (and legacy `EMBEDDING_OLLAMA`) are CI-only fallbacks when
 * the sqlite key is unset.
 */
function parseEnabledFlag(
  sqliteValue: string | null,
  envCandidates: Array<string | null | undefined>,
  defaultEnabled: boolean,
): boolean {
  if (sqliteValue === "1") return true;
  if (sqliteValue === "0") return false;
  for (const candidate of envCandidates) {
    const env = candidate?.trim();
    if (env === "1") return true;
    if (env === "0") return false;
  }
  return defaultEnabled;
}

export function isLocalEnabled(sqlite: Database.Database = getSqlite()): boolean {
  return parseEnabledFlag(
    getAppSetting("local_enabled", sqlite),
    [process.env.LOCAL_ENABLED],
    true,
  );
}

export function isOpenAiEnabled(sqlite: Database.Database = getSqlite()): boolean {
  return parseEnabledFlag(
    getAppSetting("openai_enabled", sqlite),
    [process.env.OPENAI_ENABLED],
    false,
  );
}

export function isVoyageEnabled(sqlite: Database.Database = getSqlite()): boolean {
  return parseEnabledFlag(
    getAppSetting("voyage_enabled", sqlite),
    [process.env.VOYAGE_ENABLED],
    false,
  );
}

export function isOllamaEnabled(sqlite: Database.Database = getSqlite()): boolean {
  return parseEnabledFlag(
    getAppSetting("ollama_enabled", sqlite),
    [process.env.OLLAMA_ENABLED, process.env.EMBEDDING_OLLAMA],
    false,
  );
}

export function isProviderIndexEnabled(
  provider: PreferredProvider,
  sqlite: Database.Database = getSqlite(),
): boolean {
  if (provider === "local") return isLocalEnabled(sqlite);
  if (provider === "ollama") return isOllamaEnabled(sqlite);
  if (provider === "openai") return isOpenAiEnabled(sqlite);
  return isVoyageEnabled(sqlite);
}

export function getOllamaSettings(sqlite: Database.Database = getSqlite()) {
  const baseUrl =
    firstNonEmpty(
      getAppSetting("ollama_base_url", sqlite),
      process.env.OLLAMA_BASE_URL,
    ) || DEFAULT_OLLAMA_BASE_URL;
  const model =
    firstNonEmpty(
      getAppSetting("ollama_embedding_model", sqlite),
      process.env.OLLAMA_EMBEDDING_MODEL,
    ) || DEFAULT_OLLAMA_MODEL;
  const enabled = isOllamaEnabled(sqlite);

  return {
    baseUrl,
    model,
    enabled,
    /** True when the index is explicitly enabled (credentials/URL alone do not count). */
    configured: enabled,
  };
}

export function getOpenAiSettings(sqlite: Database.Database = getSqlite()) {
  return {
    baseUrl:
      firstNonEmpty(
        getAppSetting("openai_base_url", sqlite),
        process.env.EMBEDDING_BASE_URL,
      ) || DEFAULT_OPENAI_BASE_URL,
    model:
      firstNonEmpty(
        getAppSetting("openai_embedding_model", sqlite),
        process.env.EMBEDDING_MODEL,
      ) || DEFAULT_OPENAI_MODEL,
    enabled: isOpenAiEnabled(sqlite),
  };
}

export function getVoyageSettings(sqlite: Database.Database = getSqlite()) {
  return {
    model:
      firstNonEmpty(
        getAppSetting("voyage_model", sqlite),
        process.env.VOYAGE_MODEL,
      ) || DEFAULT_VOYAGE_MODEL,
    enabled: isVoyageEnabled(sqlite),
  };
}

/** Preferred default semantic provider from Settings, then env. Null = auto. */
export function getPreferredEmbeddingProvider(
  sqlite: Database.Database = getSqlite(),
): PreferredProvider | null {
  return (
    parseProvider(getAppSetting("embedding_provider", sqlite)) ||
    parseProvider(process.env.EMBEDDING_PROVIDER) ||
    null
  );
}

export function getEmbeddingTimeoutMs(
  sqlite: Database.Database = getSqlite(),
): number {
  const raw =
    firstNonEmpty(
      getAppSetting("embedding_timeout_ms", sqlite),
      process.env.EMBEDDING_TIMEOUT_MS,
    ) || String(DEFAULT_TIMEOUT_MS);
  const timeout = Number(raw);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("embedding timeout must be a positive number of milliseconds");
  }
  return timeout;
}

export type RuntimeAppSettings = {
  preferredProvider: PreferredProvider | null;
  timeoutMs: number;
  local: { enabled: boolean };
  openai: { baseUrl: string; model: string; enabled: boolean };
  voyage: { model: string; enabled: boolean };
  ollama: ReturnType<typeof getOllamaSettings>;
};

/** Fresh read of all non-secret runtime settings (sqlite → env → defaults). */
export function getRuntimeAppSettings(
  sqlite: Database.Database = getSqlite(),
): RuntimeAppSettings {
  return {
    preferredProvider: getPreferredEmbeddingProvider(sqlite),
    timeoutMs: getEmbeddingTimeoutMs(sqlite),
    local: { enabled: isLocalEnabled(sqlite) },
    openai: getOpenAiSettings(sqlite),
    voyage: getVoyageSettings(sqlite),
    ollama: getOllamaSettings(sqlite),
  };
}
