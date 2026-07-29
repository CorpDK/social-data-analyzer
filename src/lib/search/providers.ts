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
  getPreferredEmbeddingProvider,
  isProviderIndexEnabled,
} from "../settings/app-settings";

export type ProviderAvailability = {
  available: EmbeddingProvider[];
  configured: Record<EmbeddingProvider, boolean>;
  enabled: Record<EmbeddingProvider, boolean>;
  default: EmbeddingProvider;
};

/** True when credentials exist (or are not required). Independent of enable. */
export function providerHasCredentials(provider: EmbeddingProvider): boolean {
  if (provider === "local" || provider === "ollama") return true;
  if (provider === "openai") return Boolean(getOpenAiApiKey());
  return Boolean(getVoyageApiKey());
}

export function isProviderEnabled(provider: EmbeddingProvider): boolean {
  return isProviderIndexEnabled(provider);
}

/**
 * Usable for search / reindex / import embedding:
 * explicit enable + credentials when required.
 * Storing an API key alone never makes a provider configured.
 */
export function isProviderConfigured(provider: EmbeddingProvider): boolean {
  return isProviderEnabled(provider) && providerHasCredentials(provider);
}

/** Enabled + credentialed neural providers (excludes local). */
export function configuredRemoteProviders(): EmbeddingProvider[] {
  const providers: EmbeddingProvider[] = [];
  if (isProviderConfigured("ollama")) providers.push("ollama");
  if (isProviderConfigured("openai")) providers.push("openai");
  if (isProviderConfigured("voyage")) providers.push("voyage");
  return providers;
}

/** All enabled + credentialed providers, local first when enabled. */
export function configuredProviders(): EmbeddingProvider[] {
  const providers: EmbeddingProvider[] = [];
  if (isProviderConfigured("local")) providers.push("local");
  providers.push(...configuredRemoteProviders());
  return providers;
}

export function defaultSearchProvider(): EmbeddingProvider {
  const preferred = getPreferredEmbeddingProvider();
  if (preferred && isProviderConfigured(preferred)) return preferred;
  if (isProviderConfigured("openai")) return "openai";
  if (isProviderConfigured("voyage")) return "voyage";
  if (isProviderConfigured("ollama")) return "ollama";
  if (isProviderConfigured("local")) return "local";
  // Hard fallback for hybrid/vec code paths when every index is disabled.
  return "local";
}

export function getProviderAvailability(): ProviderAvailability {
  const enabled = {
    local: isProviderEnabled("local"),
    ollama: isProviderEnabled("ollama"),
    openai: isProviderEnabled("openai"),
    voyage: isProviderEnabled("voyage"),
  } satisfies Record<EmbeddingProvider, boolean>;

  const configured = {
    local: isProviderConfigured("local"),
    ollama: isProviderConfigured("ollama"),
    openai: isProviderConfigured("openai"),
    voyage: isProviderConfigured("voyage"),
  } satisfies Record<EmbeddingProvider, boolean>;

  const available: EmbeddingProvider[] = [];
  if (configured.local) available.push("local");
  if (configured.ollama) available.push("ollama");
  if (configured.openai) available.push("openai");
  if (configured.voyage) available.push("voyage");

  return {
    available,
    configured,
    enabled,
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
    const fallback =
      availability.available[0] ??
      (isProviderConfigured("local") ? "local" : fallbackDefault);
    return {
      requested,
      provider: fallback,
      fallback: true,
      reason: `${requested} is not enabled; using ${fallback} semantic search.`,
    };
  }

  const config = embeddingConfigForProvider(requested);
  // Ollama uses a dummy bearer token; cloud providers need a real key.
  if (requested !== "local" && requested !== "ollama" && !config.apiKey) {
    const fallback =
      availability.available.find((p) => p !== requested) ?? "local";
    return {
      requested,
      provider: fallback,
      fallback: true,
      reason: `${requested} API key is missing; using ${fallback} semantic search.`,
    };
  }

  return {
    requested,
    provider: requested,
    fallback: false,
  };
}
