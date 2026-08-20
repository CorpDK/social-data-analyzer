import type { Pool } from "pg";
import type {
  AppSettingKey,
  LibraryEnables,
  PreferredProvider,
  RuntimeAppSettings,
  SearchLibrarySetting,
} from "../../settings/app-settings";
import type { SettingsStore } from "../ports";

const ENABLE_KEYS: Record<
  PreferredProvider,
  Record<SearchLibrarySetting, AppSettingKey>
> = {
  local: { saves: "saves_local_enabled", likes: "likes_local_enabled" },
  ollama: { saves: "saves_ollama_enabled", likes: "likes_ollama_enabled" },
  openai: { saves: "saves_openai_enabled", likes: "likes_openai_enabled" },
  voyage: { saves: "saves_voyage_enabled", likes: "likes_voyage_enabled" },
};

const LEGACY_ENABLE_KEYS: Record<PreferredProvider, AppSettingKey> = {
  local: "local_enabled",
  ollama: "ollama_enabled",
  openai: "openai_enabled",
  voyage: "voyage_enabled",
};

function firstNonEmpty(
  ...values: Array<string | null | undefined>
): string | null {
  return values.map((value) => value?.trim()).find(Boolean) ?? null;
}

function parseProvider(value: string | null): PreferredProvider | null {
  return value === "local" ||
    value === "ollama" ||
    value === "openai" ||
    value === "voyage"
    ? value
    : null;
}

function envEnabled(
  provider: PreferredProvider,
  library: SearchLibrarySetting,
): boolean {
  const prefix = library.toUpperCase();
  const candidates = [
    process.env[`${prefix}_${provider.toUpperCase()}_ENABLED`],
    process.env[`${provider.toUpperCase()}_ENABLED`],
    provider === "ollama" ? process.env.EMBEDDING_OLLAMA : undefined,
  ];
  for (const value of candidates) {
    if (value === "1") return true;
    if (value === "0") return false;
  }
  return provider === "local";
}

export function createPostgresSettingsStore(pool: Pool): SettingsStore {
  const getAppSetting = async (key: AppSettingKey): Promise<string | null> => {
    const result = await pool.query<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = $1",
      [key],
    );
    return result.rows[0]?.value.trim() || null;
  };

  const setAppSetting = async (
    key: AppSettingKey,
    value: string | null,
  ): Promise<void> => {
    const normalized = value?.trim();
    if (!normalized) {
      await pool.query("DELETE FROM app_settings WHERE key = $1", [key]);
      return;
    }
    await pool.query(
      `INSERT INTO app_settings(key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT(key) DO UPDATE
       SET value = excluded.value, updated_at = now()`,
      [key, normalized],
    );
  };

  const isProviderIndexEnabled = async (
    provider: PreferredProvider,
    library: SearchLibrarySetting,
  ): Promise<boolean> => {
    const direct = await getAppSetting(ENABLE_KEYS[provider][library]);
    if (direct === "1" || direct === "0") return direct === "1";
    const legacy = await getAppSetting(LEGACY_ENABLE_KEYS[provider]);
    if (legacy === "1" || legacy === "0") return legacy === "1";
    return envEnabled(provider, library);
  };

  const getProviderLibraryEnables = async (
    provider: PreferredProvider,
  ): Promise<LibraryEnables> => ({
    saves: await isProviderIndexEnabled(provider, "saves"),
    likes: await isProviderIndexEnabled(provider, "likes"),
  });

  const getPreferredEmbeddingProvider =
    async (): Promise<PreferredProvider | null> =>
      parseProvider(
        firstNonEmpty(
          await getAppSetting("embedding_provider"),
          process.env.EMBEDDING_PROVIDER,
        ),
      );

  const getEmbeddingTimeoutMs = async (): Promise<number> => {
    const raw =
      firstNonEmpty(
        await getAppSetting("embedding_timeout_ms"),
        process.env.EMBEDDING_TIMEOUT_MS,
      ) ?? "10000";
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("embedding timeout must be a positive number of milliseconds");
    }
    return value;
  };

  const getRuntimeAppSettings = async (): Promise<RuntimeAppSettings> => {
    const [
      preferredProvider,
      timeoutMs,
      local,
      openai,
      voyage,
      ollama,
      openaiBaseUrl,
      openaiModel,
      voyageModel,
      ollamaBaseUrl,
      ollamaModel,
    ] = await Promise.all([
      getPreferredEmbeddingProvider(),
      getEmbeddingTimeoutMs(),
      getProviderLibraryEnables("local"),
      getProviderLibraryEnables("openai"),
      getProviderLibraryEnables("voyage"),
      getProviderLibraryEnables("ollama"),
      getAppSetting("openai_base_url"),
      getAppSetting("openai_embedding_model"),
      getAppSetting("voyage_model"),
      getAppSetting("ollama_base_url"),
      getAppSetting("ollama_embedding_model"),
    ]);
    return {
      preferredProvider,
      timeoutMs,
      local: { enabled: local },
      openai: {
        baseUrl:
          firstNonEmpty(openaiBaseUrl, process.env.EMBEDDING_BASE_URL) ??
          "https://api.openai.com/v1",
        model:
          firstNonEmpty(openaiModel, process.env.EMBEDDING_MODEL) ??
          "text-embedding-3-small",
        enabled: openai,
      },
      voyage: {
        model:
          firstNonEmpty(voyageModel, process.env.VOYAGE_MODEL) ??
          "voyage-4-lite",
        enabled: voyage,
      },
      ollama: {
        baseUrl:
          firstNonEmpty(ollamaBaseUrl, process.env.OLLAMA_BASE_URL) ??
          "http://127.0.0.1:11434/v1",
        model:
          firstNonEmpty(ollamaModel, process.env.OLLAMA_EMBEDDING_MODEL) ??
          "qwen3-embedding:0.6b",
        enabled: ollama,
        configured: ollama.saves || ollama.likes,
      },
    };
  };

  return {
    getAppSetting,
    setAppSetting,
    getRuntimeAppSettings,
    getPreferredEmbeddingProvider,
    getEmbeddingTimeoutMs,
    getProviderLibraryEnables,
    setProviderLibraryEnabled: async (provider, library, enabled) => {
      await setAppSetting(ENABLE_KEYS[provider][library], enabled ? "1" : "0");
      await setAppSetting(LEGACY_ENABLE_KEYS[provider], null);
    },
    isProviderIndexEnabled,
  };
}
