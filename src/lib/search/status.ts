import { getSqlite } from "../db";
import {
  embeddingConfigForProvider,
  type EmbeddingProfile,
  type EmbeddingProvider,
} from "./embeddings";
import {
  embeddingProfilesMatch,
  getIndexedEmbeddingProfile,
  getIndexedEmbeddingProfileMeta,
  vecCount,
  vectorTableDimensions,
  type VectorIndexName,
} from "./sync";
import {
  isProviderConfigured,
  isProviderEnabled,
  providerHasCredentials,
} from "./providers";
import { getLatestEmbeddingJob, type EmbeddingJobRecord } from "./jobs";

export type IndexHealth =
  | "ready"
  | "partial"
  | "stale"
  | "empty"
  | "unavailable";

export type ProviderIndexStatus = {
  provider: EmbeddingProvider;
  /** Explicit Settings enable flag (independent of credentials). */
  enabled: boolean;
  /** Credentials present when required (local/ollama always true). */
  hasCredentials: boolean;
  /** Ready for search/reindex: enabled && hasCredentials. */
  configured: boolean;
  indexPresent: boolean;
  totalItems: number;
  embeddedCount: number;
  coveragePercent: number;
  health: IndexHealth;
  hint: string | null;
  stored: (EmbeddingProfile & { updatedAt: number | null }) | null;
  expected: EmbeddingProfile | null;
  tableDimensions: number | null;
};

export type SearchIndexStatus = {
  totalItems: number;
  ftsCount: number;
  providers: ProviderIndexStatus[];
  job: EmbeddingJobRecord | null;
  cancelSupported: true;
};

function coveragePercent(embedded: number, total: number): number {
  if (total <= 0) return embedded > 0 ? 100 : 0;
  return Math.min(100, Math.round((embedded / total) * 1000) / 10);
}

function providerHint(
  provider: EmbeddingProvider,
  enabled: boolean,
  hasCredentials: boolean,
  health: IndexHealth,
): string | null {
  if (!enabled && hasCredentials) {
    return "Credentials saved — enable in Settings to use this index";
  }
  if (!enabled) {
    return "Enable in Settings then Reindex";
  }
  if (!hasCredentials) {
    return `Add ${provider === "openai" ? "OpenAI" : "Voyage"} API key in Settings`;
  }
  if (health === "empty") {
    return "Index is empty — run Reindex to build vectors";
  }
  if (health === "partial") {
    return "Coverage incomplete — Reindex to finish embedding all items";
  }
  if (health === "stale") {
    return "Stored model/dimensions differ from Settings — Rebuild recommended";
  }
  if (provider !== "local" && health === "ready") return null;
  return null;
}

export function getProviderIndexStatus(
  provider: EmbeddingProvider,
  totalItems?: number,
): ProviderIndexStatus {
  const sqlite = getSqlite();
  const total =
    totalItems ??
    (
      sqlite.prepare(`SELECT count(*) AS c FROM saved_items`).get() as {
        c: number;
      }
    ).c;

  const enabled = isProviderEnabled(provider);
  const hasCredentials = providerHasCredentials(provider);
  const configured = isProviderConfigured(provider);
  const index = provider as VectorIndexName;
  const tableDimensions = vectorTableDimensions(index, sqlite);
  // Report stored coverage even when disabled so the UI can show leftover indexes.
  const embeddedCount = vecCount(index, sqlite);
  const meta = getIndexedEmbeddingProfileMeta(index, sqlite);
  const storedProfile = getIndexedEmbeddingProfile(index, sqlite);
  const expected = hasCredentials
    ? embeddingConfigForProvider(provider).profile
    : null;

  const indexPresent = tableDimensions !== null && embeddedCount > 0;
  let health: IndexHealth;

  if (!configured) {
    health = "unavailable";
  } else if (!storedProfile || embeddedCount === 0) {
    health = "empty";
  } else if (
    !expected ||
    !embeddingProfilesMatch(storedProfile, expected) ||
    tableDimensions !== expected.dimensions
  ) {
    health = "stale";
  } else if (embeddedCount < total) {
    health = "partial";
  } else {
    health = "ready";
  }

  return {
    provider,
    enabled,
    hasCredentials,
    configured,
    indexPresent,
    totalItems: total,
    embeddedCount,
    coveragePercent: coveragePercent(embeddedCount, total),
    health,
    hint: providerHint(provider, enabled, hasCredentials, health),
    stored: storedProfile
      ? {
          ...storedProfile,
          updatedAt: meta?.updatedAt ?? null,
        }
      : null,
    expected,
    tableDimensions,
  };
}

export function getSearchIndexStatus(): SearchIndexStatus {
  const sqlite = getSqlite();
  const totalItems = (
    sqlite.prepare(`SELECT count(*) AS c FROM saved_items`).get() as {
      c: number;
    }
  ).c;
  const ftsCount = (
    sqlite.prepare(`SELECT count(*) AS c FROM saved_items_fts`).get() as {
      c: number;
    }
  ).c;

  const providers: EmbeddingProvider[] = [
    "local",
    "ollama",
    "openai",
    "voyage",
  ];

  return {
    totalItems,
    ftsCount,
    providers: providers.map((provider) =>
      getProviderIndexStatus(provider, totalItems),
    ),
    job: getLatestEmbeddingJob(),
    cancelSupported: true,
  };
}
