import { getSqlite } from "../db";
import {
  embeddingConfigForProvider,
  type EmbeddingProfile,
  type EmbeddingProvider,
} from "./embeddings";
import {
  formatJobTarget,
  libraryLabel,
  type SearchLibrary,
} from "./library";
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
import {
  ensureJobRunner,
  getDisplayEmbeddingJob,
  getPendingEmbeddingJobs,
  getRecentEmbeddingJobs,
  type EmbeddingJobRecord,
} from "./jobs";

export type IndexHealth =
  | "ready"
  | "partial"
  | "stale"
  | "empty"
  | "unavailable";

export type ProviderIndexStatus = {
  library: SearchLibrary;
  libraryLabel: string;
  /** Job target for reindex API (`local` or `likes-local`, etc.). */
  target: string;
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

export type LibraryIndexStatus = {
  library: SearchLibrary;
  libraryLabel: string;
  totalItems: number;
  ftsCount: number;
  providers: ProviderIndexStatus[];
};

export type SearchIndexStatus = {
  /** @deprecated Prefer `libraries.saves` — kept for older clients. */
  totalItems: number;
  /** @deprecated Prefer `libraries.saves` — kept for older clients. */
  ftsCount: number;
  /** @deprecated Prefer `libraries.saves.providers` — kept for older clients. */
  providers: ProviderIndexStatus[];
  libraries: {
    saves: LibraryIndexStatus;
    likes: LibraryIndexStatus;
  };
  /** Active running job, or latest finished when idle. */
  job: EmbeddingJobRecord | null;
  /** Jobs waiting to run (FIFO by id). */
  pendingJobs: EmbeddingJobRecord[];
  /** Recent terminal jobs (completed / failed / cancelled). */
  recentJobs: EmbeddingJobRecord[];
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
    return "Credentials saved — enable for this library in Settings to use this index";
  }
  if (!enabled) {
    return "Enable for this library in Settings then Reindex";
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
  library: SearchLibrary,
  provider: EmbeddingProvider,
  totalItems?: number,
): ProviderIndexStatus {
  const sqlite = getSqlite();
  const table = library === "saves" ? "saved_items" : "liked_items";
  const total =
    totalItems ??
    (
      sqlite.prepare(`SELECT count(*) AS c FROM ${table}`).get() as {
        c: number;
      }
    ).c;

  const enabled = isProviderEnabled(provider, library);
  const hasCredentials = providerHasCredentials(provider);
  const configured = isProviderConfigured(provider, library);
  const index = provider as VectorIndexName;
  const tableDimensions = vectorTableDimensions(library, index, sqlite);
  const embeddedCount = vecCount(library, index, sqlite);
  const meta = getIndexedEmbeddingProfileMeta(library, index, sqlite);
  const storedProfile = getIndexedEmbeddingProfile(library, index, sqlite);
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
    library,
    libraryLabel: libraryLabel(library),
    target: formatJobTarget(library, provider),
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

function getLibraryIndexStatus(library: SearchLibrary): LibraryIndexStatus {
  const sqlite = getSqlite();
  const itemsTable = library === "saves" ? "saved_items" : "liked_items";
  const ftsTable = library === "saves" ? "saved_items_fts" : "liked_items_fts";
  const totalItems = (
    sqlite.prepare(`SELECT count(*) AS c FROM ${itemsTable}`).get() as {
      c: number;
    }
  ).c;
  const ftsCount = (
    sqlite.prepare(`SELECT count(*) AS c FROM ${ftsTable}`).get() as {
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
    library,
    libraryLabel: libraryLabel(library),
    totalItems,
    ftsCount,
    providers: providers.map((provider) =>
      getProviderIndexStatus(library, provider, totalItems),
    ),
  };
}

export function getSearchIndexStatus(): SearchIndexStatus {
  ensureJobRunner();

  const saves = getLibraryIndexStatus("saves");
  const likes = getLibraryIndexStatus("likes");

  return {
    totalItems: saves.totalItems,
    ftsCount: saves.ftsCount,
    providers: saves.providers,
    libraries: { saves, likes },
    job: getDisplayEmbeddingJob(),
    pendingJobs: getPendingEmbeddingJobs(),
    recentJobs: getRecentEmbeddingJobs(8),
    cancelSupported: true,
  };
}
