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
import type { SearchLibrary } from "./library";

export type ProviderAvailability = {
  library: SearchLibrary;
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

export function isProviderEnabled(
  provider: EmbeddingProvider,
  library: SearchLibrary,
): boolean {
  return isProviderIndexEnabled(provider, library);
}

/**
 * Usable for search / reindex / import embedding:
 * explicit enable for that library + credentials when required.
 * Storing an API key alone never makes a provider configured.
 */
export function isProviderConfigured(
  provider: EmbeddingProvider,
  library: SearchLibrary,
): boolean {
  return isProviderEnabled(provider, library) && providerHasCredentials(provider);
}

/** Enabled + credentialed neural providers for a library (excludes local). */
export function configuredRemoteProviders(
  library: SearchLibrary,
): EmbeddingProvider[] {
  const providers: EmbeddingProvider[] = [];
  if (isProviderConfigured("ollama", library)) providers.push("ollama");
  if (isProviderConfigured("openai", library)) providers.push("openai");
  if (isProviderConfigured("voyage", library)) providers.push("voyage");
  return providers;
}

/** All enabled + credentialed providers for a library, local first when enabled. */
export function configuredProviders(
  library: SearchLibrary,
): EmbeddingProvider[] {
  const providers: EmbeddingProvider[] = [];
  if (isProviderConfigured("local", library)) providers.push("local");
  providers.push(...configuredRemoteProviders(library));
  return providers;
}

export function defaultSearchProvider(
  library: SearchLibrary,
): EmbeddingProvider {
  const preferred = getPreferredEmbeddingProvider();
  if (preferred && isProviderConfigured(preferred, library)) return preferred;
  if (isProviderConfigured("openai", library)) return "openai";
  if (isProviderConfigured("voyage", library)) return "voyage";
  if (isProviderConfigured("ollama", library)) return "ollama";
  if (isProviderConfigured("local", library)) return "local";
  // Hard fallback for hybrid/vec code paths when every index is disabled.
  return "local";
}

export function getProviderAvailability(
  library: SearchLibrary = "saves",
): ProviderAvailability {
  const enabled = {
    local: isProviderEnabled("local", library),
    ollama: isProviderEnabled("ollama", library),
    openai: isProviderEnabled("openai", library),
    voyage: isProviderEnabled("voyage", library),
  } satisfies Record<EmbeddingProvider, boolean>;

  const configured = {
    local: isProviderConfigured("local", library),
    ollama: isProviderConfigured("ollama", library),
    openai: isProviderConfigured("openai", library),
    voyage: isProviderConfigured("voyage", library),
  } satisfies Record<EmbeddingProvider, boolean>;

  const available: EmbeddingProvider[] = [];
  if (configured.local) available.push("local");
  if (configured.ollama) available.push("ollama");
  if (configured.openai) available.push("openai");
  if (configured.voyage) available.push("voyage");

  return {
    library,
    available,
    configured,
    enabled,
    default: defaultSearchProvider(library),
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
  library: SearchLibrary,
): ResolvedSearchProvider {
  const availability = getProviderAvailability(library);
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
      (isProviderConfigured("local", library) ? "local" : fallbackDefault);
    return {
      requested,
      provider: fallback,
      fallback: true,
      reason: `${requested} is not enabled for ${library}; using ${fallback} semantic search.`,
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
