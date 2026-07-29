import {
  embeddingConfigForProvider,
  type EmbeddingProvider,
} from "./embeddings";

export type ProviderAvailability = {
  available: EmbeddingProvider[];
  configured: Record<EmbeddingProvider, boolean>;
  default: EmbeddingProvider;
};

function isOpenAiConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function isVoyageConfigured(): boolean {
  return Boolean(process.env.VOYAGE_API_KEY?.trim());
}

export function isProviderConfigured(provider: EmbeddingProvider): boolean {
  if (provider === "local") return true;
  if (provider === "openai") return isOpenAiConfigured();
  return isVoyageConfigured();
}

export function configuredRemoteProviders(): EmbeddingProvider[] {
  const providers: EmbeddingProvider[] = [];
  if (isOpenAiConfigured()) providers.push("openai");
  if (isVoyageConfigured()) providers.push("voyage");
  return providers;
}

export function defaultSearchProvider(): EmbeddingProvider {
  const explicit = process.env.EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (explicit === "local" || explicit === "openai" || explicit === "voyage") {
    if (isProviderConfigured(explicit)) return explicit;
  }
  if (isOpenAiConfigured()) return "openai";
  if (isVoyageConfigured()) return "voyage";
  return "local";
}

export function getProviderAvailability(): ProviderAvailability {
  const configured = {
    local: true,
    openai: isOpenAiConfigured(),
    voyage: isVoyageConfigured(),
  } satisfies Record<EmbeddingProvider, boolean>;

  const available: EmbeddingProvider[] = ["local"];
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
  if (value === "local" || value === "openai" || value === "voyage") {
    return value;
  }
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
  if (requested !== "local" && !config.apiKey) {
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
