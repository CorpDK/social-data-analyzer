import type Database from "better-sqlite3";

export type PreferredProvider = "local" | "ollama" | "openai" | "voyage";

export type SearchLibrarySetting = "saves" | "likes";

export type LibraryEnables = {
  saves: boolean;
  likes: boolean;
};

export type AppSettingKey =
  | "local_enabled"
  | "ollama_base_url"
  | "ollama_embedding_model"
  | "ollama_enabled"
  | "openai_enabled"
  | "voyage_enabled"
  | "saves_local_enabled"
  | "likes_local_enabled"
  | "saves_ollama_enabled"
  | "likes_ollama_enabled"
  | "saves_openai_enabled"
  | "likes_openai_enabled"
  | "saves_voyage_enabled"
  | "likes_voyage_enabled"
  | "embedding_provider"
  | "openai_base_url"
  | "openai_embedding_model"
  | "voyage_model"
  | "embedding_timeout_ms"
  | "postgres_advanced_enabled";

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

const LEGACY_ENABLED_KEYS: Record<PreferredProvider, AppSettingKey> = {
  local: "local_enabled",
  ollama: "ollama_enabled",
  openai: "openai_enabled",
  voyage: "voyage_enabled",
};

const LIBRARY_ENABLED_KEYS: Record<
  PreferredProvider,
  Record<SearchLibrarySetting, AppSettingKey>
> = {
  local: {
    saves: "saves_local_enabled",
    likes: "likes_local_enabled",
  },
  ollama: {
    saves: "saves_ollama_enabled",
    likes: "likes_ollama_enabled",
  },
  openai: {
    saves: "saves_openai_enabled",
    likes: "likes_openai_enabled",
  },
  voyage: {
    saves: "saves_voyage_enabled",
    likes: "likes_voyage_enabled",
  },
};

/**
 * One-shot: copy shared `*_enabled` keys into per-library keys, then drop the
 * shared keys. Safe to call repeatedly. Keeps Settings UI / DB reads consistent
 * without needing the legacy keys forever.
 *
 * Migration note: keys `local_enabled`, `ollama_enabled`, `openai_enabled`,
 * `voyage_enabled` are quarantined — still in `AppSettingKey` for delete/migrate,
 * but new writes always use `saves_*` / `likes_*` keys.
 */
const legacyEnableMigrated = new WeakSet<object>();

export function migrateLegacyProviderEnableKeys(
  sqlite: Database.Database,
) {
  if (legacyEnableMigrated.has(sqlite)) return;
  for (const provider of PROVIDER_VALUES) {
    const legacyKey = LEGACY_ENABLED_KEYS[provider];
    const legacyValue = getAppSetting(legacyKey, sqlite);
    if (legacyValue !== "1" && legacyValue !== "0") continue;

    for (const library of ["saves", "likes"] as const) {
      const libraryKey = LIBRARY_ENABLED_KEYS[provider][library];
      const existing = getAppSetting(libraryKey, sqlite);
      if (existing !== "1" && existing !== "0") {
        setAppSetting(libraryKey, legacyValue, sqlite);
      }
    }
    setAppSetting(legacyKey, null, sqlite);
  }
  legacyEnableMigrated.add(sqlite);
}

export function getAppSetting(
  key: AppSettingKey,
  sqlite: Database.Database,
): string | null {
  const row = sqlite
    .prepare(`SELECT value FROM app_settings WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  const value = row?.value?.trim();
  return value ? value : null;
}

export function setAppSetting(
  key: AppSettingKey,
  value: string | null,
  sqlite: Database.Database,
) {
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
 * Per-library keys: `saves_openai_enabled`, `likes_openai_enabled`, …
 * Legacy shared keys (`openai_enabled`, …): if set, apply to both libraries.
 * Defaults: local on for both; openai / voyage / ollama off for both.
 * Env `*_ENABLED=1|0` (and legacy `EMBEDDING_OLLAMA`) are CI-only fallbacks when
 * sqlite keys are unset.
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

function defaultEnabledForProvider(provider: PreferredProvider): boolean {
  return provider === "local";
}

function envCandidatesForProvider(
  provider: PreferredProvider,
  library: SearchLibrarySetting,
): Array<string | null | undefined> {
  const libraryPrefix = library.toUpperCase();
  if (provider === "local") {
    return [
      process.env[`${libraryPrefix}_LOCAL_ENABLED`],
      process.env.LOCAL_ENABLED,
    ];
  }
  if (provider === "ollama") {
    return [
      process.env[`${libraryPrefix}_OLLAMA_ENABLED`],
      process.env.OLLAMA_ENABLED,
      process.env.EMBEDDING_OLLAMA,
    ];
  }
  if (provider === "openai") {
    return [
      process.env[`${libraryPrefix}_OPENAI_ENABLED`],
      process.env.OPENAI_ENABLED,
    ];
  }
  return [
    process.env[`${libraryPrefix}_VOYAGE_ENABLED`],
    process.env.VOYAGE_ENABLED,
  ];
}

export function isProviderIndexEnabled(
  provider: PreferredProvider,
  library: SearchLibrarySetting,
  sqlite: Database.Database,
): boolean {
  migrateLegacyProviderEnableKeys(sqlite);

  const libraryKey = LIBRARY_ENABLED_KEYS[provider][library];
  const libraryValue = getAppSetting(libraryKey, sqlite);
  if (libraryValue === "1" || libraryValue === "0") {
    return libraryValue === "1";
  }

  return parseEnabledFlag(
    null,
    envCandidatesForProvider(provider, library),
    defaultEnabledForProvider(provider),
  );
}

/** True when enabled for the given library, or either library if omitted. */
export function isLocalEnabled(
  libraryOrSqlite: SearchLibrarySetting | Database.Database,
  maybeSqlite?: Database.Database,
): boolean {
  if (libraryOrSqlite === "saves" || libraryOrSqlite === "likes") {
    if (!maybeSqlite) {
      throw new Error("isLocalEnabled(library, sqlite) requires sqlite");
    }
    return isProviderIndexEnabled("local", libraryOrSqlite, maybeSqlite);
  }
  return (
    isProviderIndexEnabled("local", "saves", libraryOrSqlite) ||
    isProviderIndexEnabled("local", "likes", libraryOrSqlite)
  );
}

export function isOpenAiEnabled(
  libraryOrSqlite: SearchLibrarySetting | Database.Database,
  maybeSqlite?: Database.Database,
): boolean {
  if (libraryOrSqlite === "saves" || libraryOrSqlite === "likes") {
    if (!maybeSqlite) {
      throw new Error("isOpenAiEnabled(library, sqlite) requires sqlite");
    }
    return isProviderIndexEnabled("openai", libraryOrSqlite, maybeSqlite);
  }
  return (
    isProviderIndexEnabled("openai", "saves", libraryOrSqlite) ||
    isProviderIndexEnabled("openai", "likes", libraryOrSqlite)
  );
}

export function isVoyageEnabled(
  libraryOrSqlite: SearchLibrarySetting | Database.Database,
  maybeSqlite?: Database.Database,
): boolean {
  if (libraryOrSqlite === "saves" || libraryOrSqlite === "likes") {
    if (!maybeSqlite) {
      throw new Error("isVoyageEnabled(library, sqlite) requires sqlite");
    }
    return isProviderIndexEnabled("voyage", libraryOrSqlite, maybeSqlite);
  }
  return (
    isProviderIndexEnabled("voyage", "saves", libraryOrSqlite) ||
    isProviderIndexEnabled("voyage", "likes", libraryOrSqlite)
  );
}

export function isOllamaEnabled(
  libraryOrSqlite: SearchLibrarySetting | Database.Database,
  maybeSqlite?: Database.Database,
): boolean {
  if (libraryOrSqlite === "saves" || libraryOrSqlite === "likes") {
    if (!maybeSqlite) {
      throw new Error("isOllamaEnabled(library, sqlite) requires sqlite");
    }
    return isProviderIndexEnabled("ollama", libraryOrSqlite, maybeSqlite);
  }
  return (
    isProviderIndexEnabled("ollama", "saves", libraryOrSqlite) ||
    isProviderIndexEnabled("ollama", "likes", libraryOrSqlite)
  );
}

export function getProviderLibraryEnables(
  provider: PreferredProvider,
  sqlite: Database.Database,
): LibraryEnables {
  return {
    saves: isProviderIndexEnabled(provider, "saves", sqlite),
    likes: isProviderIndexEnabled(provider, "likes", sqlite),
  };
}

export function setProviderLibraryEnabled(
  provider: PreferredProvider,
  library: SearchLibrarySetting,
  enabled: boolean,
  sqlite: Database.Database,
) {
  const otherLibrary: SearchLibrarySetting =
    library === "saves" ? "likes" : "saves";
  const otherKey = LIBRARY_ENABLED_KEYS[provider][otherLibrary];
  const otherValue = getAppSetting(otherKey, sqlite);
  if (otherValue !== "1" && otherValue !== "0") {
    // Persist the other library from legacy/default before dropping the shared key.
    const legacyValue = getAppSetting(LEGACY_ENABLED_KEYS[provider], sqlite);
    if (legacyValue === "1" || legacyValue === "0") {
      setAppSetting(otherKey, legacyValue, sqlite);
    } else {
      setAppSetting(
        otherKey,
        defaultEnabledForProvider(provider) ? "1" : "0",
        sqlite,
      );
    }
  }

  setAppSetting(
    LIBRARY_ENABLED_KEYS[provider][library],
    enabled ? "1" : "0",
    sqlite,
  );
  // Drop legacy shared key once per-library keys exist so reads stay consistent.
  setAppSetting(LEGACY_ENABLED_KEYS[provider], null, sqlite);
}

export function getOllamaSettings(sqlite: Database.Database) {
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
  const enabled = getProviderLibraryEnables("ollama", sqlite);

  return {
    baseUrl,
    model,
    enabled,
    /** True when the index is explicitly enabled for either library. */
    configured: enabled.saves || enabled.likes,
  };
}

export function getOpenAiSettings(sqlite: Database.Database) {
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
    enabled: getProviderLibraryEnables("openai", sqlite),
  };
}

export function getVoyageSettings(sqlite: Database.Database) {
  return {
    model:
      firstNonEmpty(
        getAppSetting("voyage_model", sqlite),
        process.env.VOYAGE_MODEL,
      ) || DEFAULT_VOYAGE_MODEL,
    enabled: getProviderLibraryEnables("voyage", sqlite),
  };
}

/** Preferred default semantic provider from Settings, then env. Null = auto. */
export function getPreferredEmbeddingProvider(
  sqlite: Database.Database,
): PreferredProvider | null {
  return (
    parseProvider(getAppSetting("embedding_provider", sqlite)) ||
    parseProvider(process.env.EMBEDDING_PROVIDER) ||
    null
  );
}

export function getEmbeddingTimeoutMs(
  sqlite: Database.Database,
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
  local: { enabled: LibraryEnables };
  openai: { baseUrl: string; model: string; enabled: LibraryEnables };
  voyage: { model: string; enabled: LibraryEnables };
  ollama: ReturnType<typeof getOllamaSettings>;
};

/** Fresh read of all non-secret runtime settings (sqlite → env → defaults). */
export function getRuntimeAppSettings(
  sqlite: Database.Database,
): RuntimeAppSettings {
  return {
    preferredProvider: getPreferredEmbeddingProvider(sqlite),
    timeoutMs: getEmbeddingTimeoutMs(sqlite),
    local: { enabled: getProviderLibraryEnables("local", sqlite) },
    openai: getOpenAiSettings(sqlite),
    voyage: getVoyageSettings(sqlite),
    ollama: getOllamaSettings(sqlite),
  };
}
