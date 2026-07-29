export type EmbeddingProvider = "local" | "openai" | "voyage";
export type EmbeddingInputType = "document" | "query";

export type EmbeddingProfile = {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  endpoint: string | null;
};

export type EmbeddingConfig = {
  profile: EmbeddingProfile;
  apiKey: string | null;
};

const LOCAL_MODEL = "feature-hash-v1";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const VOYAGE_ENDPOINT = "https://api.voyageai.com/v1/embeddings";
export const EMBEDDING_DIMENSIONS = 1024;

export function assertValidEmbeddingProvider(
  value: string,
): EmbeddingProvider {
  if (value === "local" || value === "openai" || value === "voyage") {
    return value;
  }
  throw new Error(
    "EMBEDDING_PROVIDER must be one of: local, openai, voyage",
  );
}

function openAiEndpoint(): string {
  const configured =
    process.env.EMBEDDING_BASE_URL?.trim() || OPENAI_BASE_URL;
  const normalized = configured.replace(/\/+$/, "");
  return normalized.endsWith("/embeddings")
    ? normalized
    : `${normalized}/embeddings`;
}

export function localEmbeddingConfig(): EmbeddingConfig {
  return {
    profile: {
      provider: "local",
      model: LOCAL_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      endpoint: null,
    },
    apiKey: null,
  };
}

function tokenize(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_\s-]+/g, " ")
    .trim();
  if (!normalized) return [];

  const tokens = new Set<string>();
  for (const word of normalized.split(/\s+/)) {
    if (!word) continue;
    tokens.add(word);
    const compact = word.replace(/[_-]/g, "");
    if (compact && compact !== word) tokens.add(compact);
    // Character trigrams help short usernames / typos.
    const padded = ` ${compact || word} `;
    for (let i = 0; i < padded.length - 2; i += 1) {
      tokens.add(padded.slice(i, i + 3));
    }
  }
  return [...tokens];
}

function fnv1a(token: string, seed: number): number {
  let hash = 0x811c9dc5 ^ seed;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic local embedding (feature hashing + L2 normalize).
 * Good enough for hybrid retrieval over usernames/collections without an API.
 * Used when no remote embedding API is configured.
 */
export function embedTextLocal(
  text: string,
  dimensions = EMBEDDING_DIMENSIONS,
): Float32Array {
  const vec = new Float32Array(dimensions);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vec;

  for (const token of tokens) {
    const weight = token.length <= 3 ? 0.5 : 1;
    for (let proj = 0; proj < 3; proj += 1) {
      const h = fnv1a(token, proj + 1);
      const idx = h % dimensions;
      const sign = fnv1a(token, proj + 100) & 1 ? 1 : -1;
      vec[idx] += sign * weight;
    }
  }

  let norm = 0;
  for (let i = 0; i < vec.length; i += 1) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i += 1) vec[i] /= norm;
  return vec;
}

export function embeddingToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function embeddingConfigForProvider(
  provider: EmbeddingProvider,
): EmbeddingConfig {
  if (provider === "local") return localEmbeddingConfig();
  if (provider === "voyage") {
    return {
      profile: {
        provider,
        model: process.env.VOYAGE_MODEL?.trim() || "voyage-4-lite",
        dimensions: EMBEDDING_DIMENSIONS,
        endpoint: VOYAGE_ENDPOINT,
      },
      apiKey: process.env.VOYAGE_API_KEY?.trim() || null,
    };
  }
  return {
    profile: {
      provider,
      model: process.env.EMBEDDING_MODEL?.trim() || "text-embedding-3-small",
      dimensions: EMBEDDING_DIMENSIONS,
      endpoint: openAiEndpoint(),
    },
    apiKey: process.env.OPENAI_API_KEY?.trim() || null,
  };
}

/** @deprecated Prefer embeddingConfigForProvider or resolveSearchProvider */
export function embeddingConfig(): EmbeddingConfig {
  const explicit = process.env.EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (explicit) {
    return embeddingConfigForProvider(assertValidEmbeddingProvider(explicit));
  }
  if (process.env.OPENAI_API_KEY?.trim()) {
    return embeddingConfigForProvider("openai");
  }
  if (process.env.VOYAGE_API_KEY?.trim()) {
    return embeddingConfigForProvider("voyage");
  }
  return localEmbeddingConfig();
}

export function isRemoteEmbeddingConfigured(): boolean {
  return Boolean(
    process.env.OPENAI_API_KEY?.trim() || process.env.VOYAGE_API_KEY?.trim(),
  );
}

export async function embedText(
  text: string,
  config: EmbeddingConfig = embeddingConfig(),
  inputType: EmbeddingInputType = "document",
): Promise<Float32Array> {
  const { profile } = config;
  if (profile.provider === "local") {
    return embedTextLocal(text, profile.dimensions);
  }
  if (!profile.endpoint) {
    throw new Error(`${profile.provider} embedding endpoint is not configured`);
  }

  const timeout = Number(process.env.EMBEDDING_TIMEOUT_MS ?? 10_000);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("EMBEDDING_TIMEOUT_MS must be a positive number");
  }

  const response = await fetch(profile.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey
        ? { authorization: `Bearer ${config.apiKey}` }
        : {}),
    },
    body: JSON.stringify(
      profile.provider === "voyage"
        ? {
            model: profile.model,
            input: text,
            input_type: inputType,
            output_dimension: profile.dimensions,
            output_dtype: "float",
          }
        : {
            model: profile.model,
            input: text,
            dimensions: profile.dimensions,
          },
    ),
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Embedding API failed (${response.status}): ${body.slice(0, 200)}`,
    );
  }

  const json = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const values = json.data?.[0]?.embedding;
  if (!values || values.length !== profile.dimensions) {
    throw new Error(
      `Embedding API returned unexpected dimensions (want ${profile.dimensions}, got ${values?.length ?? 0})`,
    );
  }
  return Float32Array.from(values);
}
