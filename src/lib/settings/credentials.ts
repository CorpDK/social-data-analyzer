import {
  getEmbeddingTimeoutMs,
  getOllamaSettings,
  getOpenAiSettings,
  getPreferredEmbeddingProvider,
  getProviderLibraryEnables,
  getVoyageSettings,
  setAppSetting,
  setProviderLibraryEnabled,
  type AppSettingKey,
  type LibraryEnables,
  type PreferredProvider,
} from "./app-settings";
import { getSqlite } from "../db";
import {
  deleteKeyringSecret,
  getKeyringSecret,
  getKeyringStatus,
  setKeyringSecret,
  type KeyringAccount,
  type KeyringStatus,
} from "./keyring";

export type SecretSource = "keyring" | "env" | null;

export type ProviderSecretStatus = {
  configured: boolean;
  source: SecretSource;
};

function envSecret(account: KeyringAccount): string | null {
  if (account === "openai") return process.env.OPENAI_API_KEY?.trim() || null;
  if (account === "voyage") return process.env.VOYAGE_API_KEY?.trim() || null;
  return process.env.OLLAMA_API_KEY?.trim() || null;
}

/** Resolve a secret: keyring first, then environment fallback. Never logs values. */
export function resolveSecret(account: KeyringAccount): {
  value: string | null;
  source: SecretSource;
} {
  const fromKeyring = getKeyringSecret(account);
  if (fromKeyring) return { value: fromKeyring, source: "keyring" };
  const fromEnv = envSecret(account);
  if (fromEnv) return { value: fromEnv, source: "env" };
  return { value: null, source: null };
}

export function getOpenAiApiKey(): string | null {
  return resolveSecret("openai").value;
}

export function getVoyageApiKey(): string | null {
  return resolveSecret("voyage").value;
}

export function getOllamaApiKey(): string | null {
  // Ollama accepts any bearer token; default keeps headers uniform.
  return resolveSecret("ollama").value || "ollama";
}

export function getSecretStatus(account: KeyringAccount): ProviderSecretStatus {
  const { value, source } = resolveSecret(account);
  return { configured: Boolean(value), source };
}

export type SettingsKeysResponse = {
  keyring: KeyringStatus;
  preferredProvider: PreferredProvider | null;
  timeoutMs: number;
  local: { enabled: LibraryEnables };
  openai: ProviderSecretStatus & {
    enabled: LibraryEnables;
    baseUrl: string;
    model: string;
  };
  voyage: ProviderSecretStatus & {
    enabled: LibraryEnables;
    model: string;
  };
  ollama: ProviderSecretStatus & {
    enabled: LibraryEnables;
    baseUrl: string;
    model: string;
    /** Usable for search/reindex when enabled for either library (API key optional). */
    available: boolean;
  };
};

export function getSettingsKeysStatus(): SettingsKeysResponse {
  const ollama = getOllamaSettings(getSqlite());
  const openai = getOpenAiSettings(getSqlite());
  const voyage = getVoyageSettings(getSqlite());
  const ollamaSecret = getSecretStatus("ollama");
  const localEnabled = getProviderLibraryEnables("local", getSqlite());
  return {
    keyring: getKeyringStatus(),
    preferredProvider: getPreferredEmbeddingProvider(getSqlite()),
    timeoutMs: getEmbeddingTimeoutMs(getSqlite()),
    local: {
      enabled: localEnabled,
    },
    openai: {
      ...getSecretStatus("openai"),
      enabled: openai.enabled,
      baseUrl: openai.baseUrl,
      model: openai.model,
    },
    voyage: {
      ...getSecretStatus("voyage"),
      enabled: voyage.enabled,
      model: voyage.model,
    },
    ollama: {
      configured: ollamaSecret.configured && ollamaSecret.source === "keyring",
      source: ollamaSecret.source === "keyring" ? "keyring" : null,
      enabled: ollama.enabled,
      baseUrl: ollama.baseUrl,
      model: ollama.model,
      available: ollama.enabled.saves || ollama.enabled.likes,
    },
  };
}

/** Boolean enables both libraries; object sets only provided libraries. */
export type LibraryEnableUpdate =
  | boolean
  | Partial<LibraryEnables>
  | null
  | undefined;

export type UpdateSettingsKeysInput = {
  openaiApiKey?: string | null;
  voyageApiKey?: string | null;
  ollamaApiKey?: string | null;
  ollamaBaseUrl?: string | null;
  ollamaModel?: string | null;
  localEnabled?: LibraryEnableUpdate;
  ollamaEnabled?: LibraryEnableUpdate;
  openaiEnabled?: LibraryEnableUpdate;
  voyageEnabled?: LibraryEnableUpdate;
  openaiBaseUrl?: string | null;
  openaiModel?: string | null;
  voyageModel?: string | null;
  preferredProvider?: PreferredProvider | "" | null;
  timeoutMs?: number | null;
};

const PROVIDERS = new Set<PreferredProvider>([
  "local",
  "ollama",
  "openai",
  "voyage",
]);

type SecretCommit = { account: KeyringAccount; value: string | null };
type SettingCommit = { key: AppSettingKey; value: string | null };
type LibraryEnableCommit = {
  provider: PreferredProvider;
  saves?: boolean;
  likes?: boolean;
};

/** Fully validated commit plan — applied atomically after validation. */
export type SettingsKeysCommitPlan = {
  secrets: SecretCommit[];
  settings: SettingCommit[];
  libraryEnables: LibraryEnableCommit[];
};

function parseLibraryEnableUpdate(
  field: string,
  value: LibraryEnableUpdate,
): LibraryEnableCommit | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") {
    return {
      provider: field as PreferredProvider,
      saves: value,
      likes: value,
    };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${field} must be a boolean or { saves?: boolean, likes?: boolean }`,
    );
  }
  const out: LibraryEnableCommit = {
    provider: field as PreferredProvider,
  };
  if (value.saves !== undefined) {
    if (typeof value.saves !== "boolean") {
      throw new Error(`${field}.saves must be a boolean`);
    }
    out.saves = value.saves;
  }
  if (value.likes !== undefined) {
    if (typeof value.likes !== "boolean") {
      throw new Error(`${field}.likes must be a boolean`);
    }
    out.likes = value.likes;
  }
  if (out.saves === undefined && out.likes === undefined) return null;
  return out;
}

function normalizeOptionalString(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error("Expected a string or null");
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Parse and validate the full settings+keys payload without writing.
 * Throws on any invalid field so callers never partial-apply.
 */
export function validateSettingsKeysInput(
  input: UpdateSettingsKeysInput,
): SettingsKeysCommitPlan {
  const keyring = getKeyringStatus();
  const wantsSecret =
    input.openaiApiKey !== undefined ||
    input.voyageApiKey !== undefined ||
    input.ollamaApiKey !== undefined;
  if (wantsSecret && !keyring.available) {
    throw new Error(
      keyring.message ??
        "System keyring is unavailable; set API keys via environment variables instead.",
    );
  }

  const secrets: SecretCommit[] = [];
  if (input.openaiApiKey !== undefined) {
    secrets.push({
      account: "openai",
      value: normalizeOptionalString(input.openaiApiKey) ?? null,
    });
  }
  if (input.voyageApiKey !== undefined) {
    secrets.push({
      account: "voyage",
      value: normalizeOptionalString(input.voyageApiKey) ?? null,
    });
  }
  if (input.ollamaApiKey !== undefined) {
    secrets.push({
      account: "ollama",
      value: normalizeOptionalString(input.ollamaApiKey) ?? null,
    });
  }

  const settings: SettingCommit[] = [];

  if (input.ollamaBaseUrl !== undefined) {
    settings.push({
      key: "ollama_base_url",
      value: normalizeOptionalString(input.ollamaBaseUrl) ?? null,
    });
  }
  if (input.ollamaModel !== undefined) {
    settings.push({
      key: "ollama_embedding_model",
      value: normalizeOptionalString(input.ollamaModel) ?? null,
    });
  }
  if (input.openaiBaseUrl !== undefined) {
    settings.push({
      key: "openai_base_url",
      value: normalizeOptionalString(input.openaiBaseUrl) ?? null,
    });
  }
  if (input.openaiModel !== undefined) {
    settings.push({
      key: "openai_embedding_model",
      value: normalizeOptionalString(input.openaiModel) ?? null,
    });
  }
  if (input.voyageModel !== undefined) {
    settings.push({
      key: "voyage_model",
      value: normalizeOptionalString(input.voyageModel) ?? null,
    });
  }

  if (input.preferredProvider !== undefined) {
    const raw = input.preferredProvider;
    if (raw === null || raw === "") {
      settings.push({ key: "embedding_provider", value: null });
    } else if (typeof raw === "string" && PROVIDERS.has(raw as PreferredProvider)) {
      settings.push({ key: "embedding_provider", value: raw });
    } else {
      throw new Error(
        "preferredProvider must be one of: local, ollama, openai, voyage (or empty for auto)",
      );
    }
  }

  if (input.timeoutMs !== undefined) {
    if (input.timeoutMs === null) {
      settings.push({ key: "embedding_timeout_ms", value: null });
    } else {
      const ms = Number(input.timeoutMs);
      if (!Number.isFinite(ms) || ms <= 0) {
        throw new Error("timeoutMs must be a positive number");
      }
      settings.push({
        key: "embedding_timeout_ms",
        value: String(Math.round(ms)),
      });
    }
  }

  const libraryEnables: LibraryEnableCommit[] = [];
  const enableFields: Array<{
    field: PreferredProvider;
    value: LibraryEnableUpdate;
  }> = [
    { field: "local", value: input.localEnabled },
    { field: "ollama", value: input.ollamaEnabled },
    { field: "openai", value: input.openaiEnabled },
    { field: "voyage", value: input.voyageEnabled },
  ];
  for (const { field, value } of enableFields) {
    const parsed = parseLibraryEnableUpdate(field, value);
    if (parsed) {
      parsed.provider = field;
      libraryEnables.push(parsed);
    }
  }

  return { secrets, settings, libraryEnables };
}

function applySettingsKeysCommitPlan(plan: SettingsKeysCommitPlan): void {
  for (const secret of plan.secrets) {
    if (secret.value === null || secret.value === "") {
      deleteKeyringSecret(secret.account);
    } else {
      setKeyringSecret(secret.account, secret.value);
    }
  }

  for (const setting of plan.settings) {
    setAppSetting(setting.key, setting.value, getSqlite());
  }

  for (const enable of plan.libraryEnables) {
    if (typeof enable.saves === "boolean") {
      setProviderLibraryEnabled(enable.provider, "saves", enable.saves, getSqlite());
    }
    if (typeof enable.likes === "boolean") {
      setProviderLibraryEnabled(enable.provider, "likes", enable.likes, getSqlite());
    }
  }
}

/**
 * Validate the full payload, then commit to SQLite/keyring.
 * No writes occur if validation fails — no partial apply.
 */
export function updateSettingsKeys(
  input: UpdateSettingsKeysInput,
): SettingsKeysResponse {
  const plan = validateSettingsKeysInput(input);
  applySettingsKeysCommitPlan(plan);
  return getSettingsKeysStatus();
}
