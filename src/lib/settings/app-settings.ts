import type Database from "better-sqlite3";
import { getSqlite } from "../db";

export type PreferredProvider = "local" | "ollama" | "openai" | "voyage";

export type AppSettingKey =
  | "ollama_base_url"
  | "ollama_embedding_model"
  | "ollama_enabled"
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
  const enabledFlag = getAppSetting("ollama_enabled", sqlite);
  const enabled =
    enabledFlag === "1" ||
    (enabledFlag !== "0" &&
      Boolean(getAppSetting("ollama_base_url", sqlite))) ||
    Boolean(process.env.OLLAMA_BASE_URL?.trim()) ||
    process.env.EMBEDDING_OLLAMA?.trim() === "1";

  return {
    baseUrl,
    model,
    enabled,
    /** True when the user/env explicitly opted into Ollama (not just defaults). */
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
  };
}

export function getVoyageSettings(sqlite: Database.Database = getSqlite()) {
  return {
    model:
      firstNonEmpty(
        getAppSetting("voyage_model", sqlite),
        process.env.VOYAGE_MODEL,
      ) || DEFAULT_VOYAGE_MODEL,
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
  openai: { baseUrl: string; model: string };
  voyage: { model: string };
  ollama: ReturnType<typeof getOllamaSettings>;
};

/** Fresh read of all non-secret runtime settings (sqlite → env → defaults). */
export function getRuntimeAppSettings(
  sqlite: Database.Database = getSqlite(),
): RuntimeAppSettings {
  return {
    preferredProvider: getPreferredEmbeddingProvider(sqlite),
    timeoutMs: getEmbeddingTimeoutMs(sqlite),
    openai: getOpenAiSettings(sqlite),
    voyage: getVoyageSettings(sqlite),
    ollama: getOllamaSettings(sqlite),
  };
}
