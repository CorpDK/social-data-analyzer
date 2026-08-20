import { getStorage } from "../storage";
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

export async function isProviderEnabled(
  provider: EmbeddingProvider,
  library: SearchLibrary,
): Promise<boolean> {
  return (await getStorage()).settings.isProviderIndexEnabled(provider, library);
}

/**
 * Usable for search / reindex / import embedding:
 * explicit enable for that library + credentials when required.
 * Storing an API key alone never makes a provider configured.
 */
export async function isProviderConfigured(
  provider: EmbeddingProvider,
  library: SearchLibrary,
): Promise<boolean> {
  return (await isProviderEnabled(provider, library)) && providerHasCredentials(provider);
}

/** Enabled + credentialed neural providers for a library (excludes local). */
export async function configuredRemoteProviders(
  library: SearchLibrary,
): Promise<EmbeddingProvider[]> {
  const providers: EmbeddingProvider[] = [];
  if (await isProviderConfigured("ollama", library)) providers.push("ollama");
  if (await isProviderConfigured("openai", library)) providers.push("openai");
  if (await isProviderConfigured("voyage", library)) providers.push("voyage");
  return providers;
}

/** All enabled + credentialed providers for a library, local first when enabled. */
export async function configuredProviders(
  library: SearchLibrary,
): Promise<EmbeddingProvider[]> {
  const providers: EmbeddingProvider[] = [];
  if (await isProviderConfigured("local", library)) providers.push("local");
  providers.push(...(await configuredRemoteProviders(library)));
  return providers;
}

export async function defaultSearchProvider(
  library: SearchLibrary,
): Promise<EmbeddingProvider> {
  const preferred = await (await getStorage()).settings.getPreferredEmbeddingProvider();
  if (preferred && (await isProviderConfigured(preferred, library))) return preferred;
  if (await isProviderConfigured("openai", library)) return "openai";
  if (await isProviderConfigured("voyage", library)) return "voyage";
  if (await isProviderConfigured("ollama", library)) return "ollama";
  if (await isProviderConfigured("local", library)) return "local";
  // Hard fallback for hybrid/vec code paths when every index is disabled.
  return "local";
}

export async function getProviderAvailability(
  library: SearchLibrary = "saves",
): Promise<ProviderAvailability> {
  const enabled = {
    local: await isProviderEnabled("local", library),
    ollama: await isProviderEnabled("ollama", library),
    openai: await isProviderEnabled("openai", library),
    voyage: await isProviderEnabled("voyage", library),
  } satisfies Record<EmbeddingProvider, boolean>;

  const configured = {
    local: await isProviderConfigured("local", library),
    ollama: await isProviderConfigured("ollama", library),
    openai: await isProviderConfigured("openai", library),
    voyage: await isProviderConfigured("voyage", library),
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
    default: await defaultSearchProvider(library),
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

export async function resolveSearchProvider(
  requested: EmbeddingProvider | null | undefined,
  library: SearchLibrary,
): Promise<ResolvedSearchProvider> {
  const availability = await getProviderAvailability(library);
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
      ((await isProviderConfigured("local", library)) ? "local" : fallbackDefault);
    return {
      requested,
      provider: fallback,
      fallback: true,
      reason: `${requested} is not enabled for ${library}; using ${fallback} semantic search.`,
    };
  }

  const config = await embeddingConfigForProvider(requested);
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
