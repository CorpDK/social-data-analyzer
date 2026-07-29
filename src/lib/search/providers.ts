import {
  embeddingConfigForProvider,
  isEmbeddingProvider,
  type EmbeddingProvider,
} from "./embeddings";
import {
  getOpenAiApiKey,
  getVoyageApiKey,
} from "../settings/credentials";
import {
  getOllamaSettings,
  getPreferredEmbeddingProvider,
} from "../settings/app-settings";

export type ProviderAvailability = {
  available: EmbeddingProvider[];
  configured: Record<EmbeddingProvider, boolean>;
  default: EmbeddingProvider;
};

function isOpenAiConfigured(): boolean {
  return Boolean(getOpenAiApiKey());
}

function isVoyageConfigured(): boolean {
  return Boolean(getVoyageApiKey());
}

/** Available when Settings/env explicitly enables Ollama (URL or EMBEDDING_OLLAMA=1). */
export function isOllamaConfigured(): boolean {
  return getOllamaSettings().configured;
}

export function isProviderConfigured(provider: EmbeddingProvider): boolean {
  if (provider === "local") return true;
  if (provider === "ollama") return isOllamaConfigured();
  if (provider === "openai") return isOpenAiConfigured();
  return isVoyageConfigured();
}

/** Neural providers maintained alongside the always-on local hasher index. */
export function configuredRemoteProviders(): EmbeddingProvider[] {
  const providers: EmbeddingProvider[] = [];
  if (isOllamaConfigured()) providers.push("ollama");
  if (isOpenAiConfigured()) providers.push("openai");
  if (isVoyageConfigured()) providers.push("voyage");
  return providers;
}

export function defaultSearchProvider(): EmbeddingProvider {
  const preferred = getPreferredEmbeddingProvider();
  if (preferred && isProviderConfigured(preferred)) return preferred;
  if (isOpenAiConfigured()) return "openai";
  if (isVoyageConfigured()) return "voyage";
  if (isOllamaConfigured()) return "ollama";
  return "local";
}

export function getProviderAvailability(): ProviderAvailability {
  const configured = {
    local: true,
    ollama: isOllamaConfigured(),
    openai: isOpenAiConfigured(),
    voyage: isVoyageConfigured(),
  } satisfies Record<EmbeddingProvider, boolean>;

  const available: EmbeddingProvider[] = ["local"];
  if (configured.ollama) available.push("ollama");
  if (configured.openai) available.push("openai");
  if (configured.voyage) available.push("voyage");

  return {
    available,
    configured,
    default: defaultSearchProvider(),
  };
}

export type ResolvedSearchProvider = {
  requested: EmbeddingProvider | null;
  provider: EmbeddingProvider;
  fallback: boolean;
  reason?: string;
};

export function parseProviderParam(
  raw: string | null | undefined,
): EmbeddingProvider | null {
  const value = raw?.trim().toLowerCase();
  if (value && isEmbeddingProvider(value)) return value;
  return null;
}

export function resolveSearchProvider(
  requested: EmbeddingProvider | null | undefined,
): ResolvedSearchProvider {
  const availability = getProviderAvailability();
  const fallbackDefault = availability.default;

  if (!requested) {
    return {
      requested: null,
      provider: fallbackDefault,
      fallback: false,
    };
  }

  if (!availability.available.includes(requested)) {
    return {
      requested,
      provider: "local",
      fallback: true,
      reason: `${requested} is not configured; using local semantic search.`,
    };
  }

  const config = embeddingConfigForProvider(requested);
  // Ollama uses a dummy bearer token; cloud providers need a real key.
  if (requested !== "local" && requested !== "ollama" && !config.apiKey) {
    return {
      requested,
      provider: "local",
      fallback: true,
      reason: `${requested} API key is missing; using local semantic search.`,
    };
  }

  return {
    requested,
    provider: requested,
    fallback: false,
  };
}
