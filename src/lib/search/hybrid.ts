import { getSqlite } from "../db";
import { jobLog } from "../job-log";
import {
  embedText,
  embeddingConfigForProvider,
  embeddingToBuffer,
  localEmbeddingConfig,
  type EmbeddingConfig,
  type EmbeddingProvider,
} from "./embeddings";
import { resolveSearchProvider } from "./providers";
import {
  vectorIndexMatchesConfig,
  type SearchLibrary,
  type VectorIndexName,
} from "./sync";
import { vectorTableName } from "./library";

export type SearchMode =
  | "hybrid"
  | "vec"
  | "hybrid-local-fallback"
  | "vec-local-fallback"
  | "fts"
  | "none";

export type RankedHit = {
  id: number;
  score: number;
  source: "fts" | "vec" | "both";
};

/**
 * Max ranked IDs for browse list/search. Keeps totals honest for typical
 * local corpora while bounding IN() / memory; callers expose totalCapped
 * when the candidate set hits this ceiling.
 */
export const BROWSE_HYBRID_SEARCH_LIMIT = 10_000;

/** sqlite-vec `k` ceiling when fetching hybrid vector candidates (engine max). */
export const HYBRID_VEC_FETCH_K_MAX = 4_096;

const RRF_K = 60;

/** Injected logger for tests; defaults to jobLog. */
type SearchWarnFn = (message: string, error?: unknown) => void;

let searchWarn: SearchWarnFn = (message, error) => {
  const detail =
    error instanceof Error
      ? error.message
      : error != null
        ? String(error)
        : undefined;
  jobLog("search", {
    message: detail ? `${message}: ${detail}` : message,
    level: "warn",
  });
};

/** Test helper — override structured warn sink. */
export function setHybridSearchWarnForTests(fn: SearchWarnFn | null) {
  searchWarn =
    fn ??
    ((message, error) => {
      const detail =
        error instanceof Error
          ? error.message
          : error != null
            ? String(error)
            : undefined;
      jobLog("search", {
        message: detail ? `${message}: ${detail}` : message,
        level: "warn",
      });
    });
}

function ftsToken(raw: string): string | null {
  const cleaned = raw.replace(/["']/g, "").trim();
  if (!cleaned) return null;
  return `"${cleaned}"*`;
}

export function buildFtsQuery(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/\b(AND|OR|NOT|NEAR)\b|"|\*/i.test(trimmed)) return trimmed;

  const parts = trimmed
    .split(/\s+/)
    .map(ftsToken)
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" ") : null;
}

function rrfMerge(
  ftsHits: Array<{ id: number; rank: number }>,
  vecHits: Array<{ id: number; distance: number }>,
): RankedHit[] {
  const scores = new Map<number, { score: number; sources: Set<"fts" | "vec"> }>();
  ftsHits.forEach((hit, index) => {
    const entry = scores.get(hit.id) ?? { score: 0, sources: new Set() };
    entry.score += 1 / (RRF_K + index + 1);
    entry.sources.add("fts");
    scores.set(hit.id, entry);
  });
  vecHits.forEach((hit, index) => {
    const entry = scores.get(hit.id) ?? { score: 0, sources: new Set() };
    entry.score += 1 / (RRF_K + index + 1);
    entry.sources.add("vec");
    scores.set(hit.id, entry);
  });
  return [...scores.entries()]
    .map(([id, entry]) => ({
      id,
      score: entry.score,
      source:
        entry.sources.size === 2
          ? ("both" as const)
          : entry.sources.has("fts")
            ? ("fts" as const)
            : ("vec" as const),
    }))
    .sort((a, b) => b.score - a.score);
}

export function searchFts(
  library: SearchLibrary,
  query: string,
  limit: number,
  sqlite: import("better-sqlite3").Database,
): { hits: Array<{ id: number; rank: number }>; degraded: boolean } {
  const match = buildFtsQuery(query);
  if (!match) return { hits: [], degraded: false };
  const table = library === "saves" ? "saved_items_fts" : "liked_items_fts";
  try {
    const hits = sqlite
      .prepare(
        `SELECT rowid AS id, rank
         FROM ${table}
         WHERE ${table} MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(match, limit) as Array<{ id: number; rank: number }>;
    return { hits, degraded: false };
  } catch (error) {
    searchWarn(`FTS query failed (${library})`, error);
    return { hits: [], degraded: true };
  }
}

type VecSearchResult = {
  hits: Array<{ id: number; distance: number }>;
  status: "ok" | "unavailable" | "failed";
};

async function searchVectorIndex(
  library: SearchLibrary,
  index: VectorIndexName,
  config: EmbeddingConfig,
  query: string,
  limit: number,
): Promise<VecSearchResult> {
  const sqlite = getSqlite();
  if (!vectorIndexMatchesConfig(library, index, config, sqlite)) {
    return { hits: [], status: "unavailable" };
  }

  const table = vectorTableName(library, index);
  const fetchK = Math.min(Math.max(limit * 2, 32), HYBRID_VEC_FETCH_K_MAX);
  try {
    const embedding = await embedText(query, config, "query");
    const rows = sqlite
      .prepare(
        `SELECT item_id AS id, distance
         FROM ${table}
         WHERE embedding MATCH ?
           AND k = ?
         ORDER BY distance`,
      )
      .all(embeddingToBuffer(embedding), fetchK) as Array<{
      id: number;
      distance: number;
    }>;
    if (rows.length === 0) return { hits: [], status: "ok" };

    const best = rows[0].distance;
    const absoluteMax = Number(process.env.VEC_DISTANCE_MAX ?? 1.22);
    const relativeMax = best + Number(process.env.VEC_DISTANCE_SLACK ?? 0.12);
    const cutoff = Math.min(absoluteMax, relativeMax);
    return {
      hits: rows.filter((row) => row.distance <= cutoff).slice(0, limit),
      status: "ok",
    };
  } catch (error) {
    searchWarn(`Vector search failed (${library}/${index})`, error);
    return { hits: [], status: "failed" };
  }
}

export type HybridSearchResult = {
  hits: RankedHit[];
  mode: SearchMode;
  provider: EmbeddingProvider;
  providerFallback: boolean;
  providerFallbackReason?: string;
  /** True when FTS threw and degraded to empty keyword hits. */
  ftsDegraded?: boolean;
  /** True when primary vec path failed (may still have local fallback hits). */
  vecDegraded?: boolean;
  /**
   * True when the ranked candidate set was cut at `limit` (more matches may
   * exist). Browse totals should surface this so UX is not silently capped.
   */
  truncated?: boolean;
};

async function hybridSearchIdsForLibrary(
  library: SearchLibrary,
  query: string,
  limit = 200,
  requestedProvider?: EmbeddingProvider | null,
): Promise<HybridSearchResult> {
  const resolved = resolveSearchProvider(requestedProvider ?? null, library);
  const ftsResult = searchFts(library, query, limit, getSqlite());
  const ftsHits = ftsResult.hits;
  const ftsDegraded = ftsResult.degraded;
  let vecResult: VecSearchResult;
  let usedFallback = false;
  let activeProvider = resolved.provider;
  let vecDegraded = false;

  if (resolved.provider === "local") {
    vecResult = await searchVectorIndex(
      library,
      "local",
      localEmbeddingConfig(),
      query,
      limit,
    );
    if (vecResult.status === "failed") vecDegraded = true;
  } else {
    const remoteConfig = embeddingConfigForProvider(resolved.provider);
    vecResult = await searchVectorIndex(
      library,
      resolved.provider,
      remoteConfig,
      query,
      limit,
    );
    if (vecResult.status !== "ok") {
      usedFallback = true;
      if (vecResult.status === "failed") vecDegraded = true;
      activeProvider = "local";
      vecResult = await searchVectorIndex(
        library,
        "local",
        localEmbeddingConfig(),
        query,
        limit,
      );
      if (vecResult.status === "failed") vecDegraded = true;
    }
  }

  if (ftsHits.length === 0 && vecResult.hits.length === 0) {
    return {
      hits: [],
      mode: "none",
      provider: activeProvider,
      providerFallback: resolved.fallback || usedFallback,
      providerFallbackReason:
        resolved.reason ??
        (usedFallback
          ? `${resolved.provider} semantic search failed; using local vectors.`
          : undefined),
      ftsDegraded,
      vecDegraded,
      truncated: false,
    };
  }

  const merged = rrfMerge(ftsHits, vecResult.hits);
  const truncated =
    merged.length > limit ||
    ftsHits.length >= limit ||
    vecResult.hits.length >= limit;
  const hits = merged.slice(0, limit);
  if (vecResult.hits.length === 0) {
    return {
      hits,
      mode: "fts",
      provider: activeProvider,
      providerFallback: resolved.fallback || usedFallback,
      providerFallbackReason: resolved.reason,
      ftsDegraded,
      vecDegraded,
      truncated,
    };
  }
  if (usedFallback || resolved.fallback) {
    return {
      hits,
      mode:
        ftsHits.length > 0
          ? "hybrid-local-fallback"
          : "vec-local-fallback",
      provider: activeProvider,
      providerFallback: true,
      providerFallbackReason:
        resolved.reason ??
        `${resolved.provider} semantic search unavailable; using local vectors.`,
      ftsDegraded,
      vecDegraded,
      truncated,
    };
  }
  return {
    hits,
    mode: ftsHits.length > 0 ? "hybrid" : "vec",
    provider: activeProvider,
    providerFallback: false,
    ftsDegraded,
    vecDegraded,
    truncated,
  };
}

export async function hybridSearchIds(
  query: string,
  limit = 200,
  requestedProvider?: EmbeddingProvider | null,
): Promise<HybridSearchResult> {
  return hybridSearchIdsForLibrary("saves", query, limit, requestedProvider);
}

export async function hybridSearchLikedIds(
  query: string,
  limit = 200,
  requestedProvider?: EmbeddingProvider | null,
): Promise<HybridSearchResult> {
  return hybridSearchIdsForLibrary("likes", query, limit, requestedProvider);
}
