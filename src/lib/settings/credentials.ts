import {
  getEmbeddingTimeoutMs,
  getOllamaSettings,
  getOpenAiSettings,
  getPreferredEmbeddingProvider,
  getVoyageSettings,
  setAppSetting,
  type PreferredProvider,
} from "./app-settings";
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
  openai: ProviderSecretStatus & {
    baseUrl: string;
    model: string;
  };
  voyage: ProviderSecretStatus & {
    model: string;
  };
  ollama: ProviderSecretStatus & {
    enabled: boolean;
    baseUrl: string;
    model: string;
    /** Non-default / explicitly configured for provider switcher. */
    available: boolean;
  };
};

export function getSettingsKeysStatus(): SettingsKeysResponse {
  const ollama = getOllamaSettings();
  const openai = getOpenAiSettings();
  const voyage = getVoyageSettings();
  const ollamaSecret = getSecretStatus("ollama");
  return {
    keyring: getKeyringStatus(),
    preferredProvider: getPreferredEmbeddingProvider(),
    timeoutMs: getEmbeddingTimeoutMs(),
    openai: {
      ...getSecretStatus("openai"),
      baseUrl: openai.baseUrl,
      model: openai.model,
    },
    voyage: {
      ...getSecretStatus("voyage"),
      model: voyage.model,
    },
    ollama: {
      configured: ollamaSecret.configured && ollamaSecret.source === "keyring",
      source: ollamaSecret.source === "keyring" ? "keyring" : null,
      enabled: ollama.configured,
      baseUrl: ollama.baseUrl,
      model: ollama.model,
      available: ollama.configured,
    },
  };
}

export type UpdateSettingsKeysInput = {
  openaiApiKey?: string | null;
  voyageApiKey?: string | null;
  ollamaApiKey?: string | null;
  ollamaBaseUrl?: string | null;
  ollamaModel?: string | null;
  ollamaEnabled?: boolean | null;
  openaiBaseUrl?: string | null;
  openaiModel?: string | null;
  voyageModel?: string | null;
  preferredProvider?: PreferredProvider | "" | null;
  timeoutMs?: number | null;
};

function applySecretUpdate(account: KeyringAccount, value: string | null | undefined) {
  if (value === undefined) return;
  if (value === null || value.trim() === "") {
    deleteKeyringSecret(account);
    return;
  }
  setKeyringSecret(account, value);
}

const PROVIDERS = new Set<PreferredProvider>([
  "local",
  "ollama",
  "openai",
  "voyage",
]);

export function updateSettingsKeys(input: UpdateSettingsKeysInput): SettingsKeysResponse {
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

  applySecretUpdate("openai", input.openaiApiKey);
  applySecretUpdate("voyage", input.voyageApiKey);
  applySecretUpdate("ollama", input.ollamaApiKey);

  if (input.ollamaBaseUrl !== undefined) {
    const url = input.ollamaBaseUrl?.trim() || null;
    setAppSetting("ollama_base_url", url);
  }
  if (input.ollamaModel !== undefined) {
    setAppSetting(
      "ollama_embedding_model",
      input.ollamaModel?.trim() || null,
    );
  }
  if (input.ollamaEnabled !== undefined && input.ollamaEnabled !== null) {
    setAppSetting("ollama_enabled", input.ollamaEnabled ? "1" : "0");
  }

  if (input.openaiBaseUrl !== undefined) {
    setAppSetting("openai_base_url", input.openaiBaseUrl?.trim() || null);
  }
  if (input.openaiModel !== undefined) {
    setAppSetting(
      "openai_embedding_model",
      input.openaiModel?.trim() || null,
    );
  }
  if (input.voyageModel !== undefined) {
    setAppSetting("voyage_model", input.voyageModel?.trim() || null);
  }

  if (input.preferredProvider !== undefined) {
    const raw = input.preferredProvider;
    if (raw === null || raw === "") {
      setAppSetting("embedding_provider", null);
    } else if (PROVIDERS.has(raw)) {
      setAppSetting("embedding_provider", raw);
    } else {
      throw new Error(
        "preferredProvider must be one of: local, ollama, openai, voyage (or empty for auto)",
      );
    }
  }

  if (input.timeoutMs !== undefined) {
    if (input.timeoutMs === null) {
      setAppSetting("embedding_timeout_ms", null);
    } else {
      const ms = Number(input.timeoutMs);
      if (!Number.isFinite(ms) || ms <= 0) {
        throw new Error("timeoutMs must be a positive number");
      }
      setAppSetting("embedding_timeout_ms", String(Math.round(ms)));
    }
  }

  return getSettingsKeysStatus();
}
