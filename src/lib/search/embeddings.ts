import {
  getOllamaApiKey,
  getOpenAiApiKey,
  getVoyageApiKey,
} from "../settings/credentials";
import { getSqlite } from "../db";
import {
  getEmbeddingTimeoutMs,
  getOllamaSettings,
  getOpenAiSettings,
  getVoyageSettings,
  isOllamaEnabled,
  isOpenAiEnabled,
  isVoyageEnabled,
} from "../settings/app-settings";

export type EmbeddingProvider = "local" | "ollama" | "openai" | "voyage";
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
const VOYAGE_ENDPOINT = "https://api.voyageai.com/v1/embeddings";
export const EMBEDDING_DIMENSIONS = 1024;

const ALL_PROVIDERS: EmbeddingProvider[] = [
  "local",
  "ollama",
  "openai",
  "voyage",
];

export function assertValidEmbeddingProvider(
  value: string,
): EmbeddingProvider {
  if (
    value === "local" ||
    value === "ollama" ||
    value === "openai" ||
    value === "voyage"
  ) {
    return value;
  }
  throw new Error(
    "EMBEDDING_PROVIDER must be one of: local, ollama, openai, voyage",
  );
}

export function isEmbeddingProvider(value: string): value is EmbeddingProvider {
  return ALL_PROVIDERS.includes(value as EmbeddingProvider);
}

function openAiCompatibleEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/embeddings")
    ? normalized
    : `${normalized}/embeddings`;
}

function openAiEndpoint(): string {
  return openAiCompatibleEndpoint(getOpenAiSettings(getSqlite()).baseUrl);
}

function ollamaEndpoint(): string {
  return openAiCompatibleEndpoint(getOllamaSettings(getSqlite()).baseUrl);
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
 * Weaker than neural models; always available offline with FTS5 hybrid.
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
  if (provider === "ollama") {
    const settings = getOllamaSettings(getSqlite());
    return {
      profile: {
        provider,
        model: settings.model,
        dimensions: EMBEDDING_DIMENSIONS,
        endpoint: ollamaEndpoint(),
      },
      apiKey: getOllamaApiKey(),
    };
  }
  if (provider === "voyage") {
    return {
      profile: {
        provider,
        model: getVoyageSettings(getSqlite()).model,
        dimensions: EMBEDDING_DIMENSIONS,
        endpoint: VOYAGE_ENDPOINT,
      },
      apiKey: getVoyageApiKey(),
    };
  }
  return {
    profile: {
      provider,
      model: getOpenAiSettings(getSqlite()).model,
      dimensions: EMBEDDING_DIMENSIONS,
      endpoint: openAiEndpoint(),
    },
    apiKey: getOpenAiApiKey(),
  };
}

/** At least one neural index is explicitly enabled and credentialed. */
export function isRemoteEmbeddingConfigured(): boolean {
  return Boolean(
    (isOpenAiEnabled(getSqlite()) && getOpenAiApiKey()) ||
      (isVoyageEnabled(getSqlite()) && getVoyageApiKey()) ||
      isOllamaEnabled(getSqlite()),
  );
}

/** Max texts per remote embedding HTTP request (Voyage / OpenAI / Ollama). */
export const EMBEDDING_API_BATCH_SIZE = 64;

function embeddingRequestTimeoutMs(batchSize: number): number {
  const timeout = getEmbeddingTimeoutMs(getSqlite());
  if (batchSize <= 1) return timeout;
  // Modest headroom for batched remote calls without unbounded waits.
  return Math.min(timeout * 8, timeout + batchSize * 250);
}

function parseEmbeddingResponse(
  json: { data?: Array<{ embedding?: number[]; index?: number }> },
  expectedCount: number,
  dimensions: number,
): Float32Array[] {
  const rows = json.data;
  if (!rows || rows.length !== expectedCount) {
    throw new Error(
      `Embedding API returned unexpected batch size (want ${expectedCount}, got ${rows?.length ?? 0})`,
    );
  }

  const ordered = [...rows].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );
  return ordered.map((row, i) => {
    const values = row.embedding;
    if (!values || values.length !== dimensions) {
      throw new Error(
        `Embedding API returned unexpected dimensions at index ${i} (want ${dimensions}, got ${values?.length ?? 0})`,
      );
    }
    return Float32Array.from(values);
  });
}

async function embedTextsRemote(
  texts: string[],
  config: EmbeddingConfig,
  inputType: EmbeddingInputType,
): Promise<Float32Array[]> {
  const { profile } = config;
  if (!profile.endpoint) {
    throw new Error(`${profile.provider} embedding endpoint is not configured`);
  }
  if (texts.length === 0) return [];

  const input = texts.length === 1 ? texts[0]! : texts;
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
            input,
            input_type: inputType,
            output_dimension: profile.dimensions,
            output_dtype: "float",
          }
        : {
            // OpenAI + Ollama OpenAI-compatible /embeddings
            model: profile.model,
            input,
            dimensions: profile.dimensions,
          },
    ),
    signal: AbortSignal.timeout(embeddingRequestTimeoutMs(texts.length)),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Embedding API failed (${response.status}): ${body.slice(0, 200)}`,
    );
  }

  const json = (await response.json()) as {
    data?: Array<{ embedding?: number[]; index?: number }>;
  };
  return parseEmbeddingResponse(json, texts.length, profile.dimensions);
}

/**
 * Batch embed many texts. Remote providers send up to
 * {@link EMBEDDING_API_BATCH_SIZE} inputs per request.
 * Query-time search should keep using {@link embedText}.
 */
export async function embedTexts(
  texts: string[],
  config: EmbeddingConfig,
  inputType: EmbeddingInputType = "document",
): Promise<Float32Array[]> {
  const { profile } = config;
  if (texts.length === 0) return [];

  if (profile.provider === "local") {
    return texts.map((text) => embedTextLocal(text, profile.dimensions));
  }

  // Ollama's OpenAI-compatible endpoint usually accepts array input; if a
  // batch request fails, fall back to sequential singles for that slice.
  if (profile.provider === "ollama") {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += EMBEDDING_API_BATCH_SIZE) {
      const slice = texts.slice(i, i + EMBEDDING_API_BATCH_SIZE);
      if (slice.length === 1) {
        out.push(...(await embedTextsRemote(slice, config, inputType)));
        continue;
      }
      try {
        out.push(...(await embedTextsRemote(slice, config, inputType)));
      } catch {
        for (const text of slice) {
          out.push(...(await embedTextsRemote([text], config, inputType)));
        }
      }
    }
    return out;
  }

  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_API_BATCH_SIZE) {
    const slice = texts.slice(i, i + EMBEDDING_API_BATCH_SIZE);
    out.push(...(await embedTextsRemote(slice, config, inputType)));
  }
  return out;
}

/** Single-text embed (query search and one-off updates). */
export async function embedText(
  text: string,
  config: EmbeddingConfig,
  inputType: EmbeddingInputType = "document",
): Promise<Float32Array> {
  const [embedding] = await embedTexts([text], config, inputType);
  if (!embedding) {
    throw new Error("Embedding API returned an empty result");
  }
  return embedding;
}
