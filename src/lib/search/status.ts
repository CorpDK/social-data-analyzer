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
  assessReindexMemory,
  CRITICAL_MIN_AVAILABLE_MB,
  estimatedVectorMegabytes,
  LARGE_LIBRARY_ITEM_THRESHOLD,
  OLLAMA_LARGE_MIN_AVAILABLE_MB,
  REMOTE_LARGE_MIN_AVAILABLE_MB,
  readMemAvailableMb,
  type ReindexMemoryAssessment,
} from "./memory";
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
  getActiveEmbeddingJob,
  getDisplayEmbeddingJob,
  getPendingEmbeddingJobs,
  getRecentEmbeddingJobs,
  type EmbeddingJobRecord,
} from "./jobs";
import { assessSearchIndexGaps, type SearchIndexGaps } from "./readiness";

export type {
  EmbeddingJobDto,
  EmbeddingProfileDto,
  HostMemoryStatusDto,
  LibraryIndexStatusDto,
  ProviderIndexStatusDto,
  SearchIndexStatusDto,
} from "./status-dto";

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
  /** Soft / strong reindex warnings for this library+provider (UI confirm). */
  reindexWarning: string | null;
  reindexStrongWarning: string | null;
  /** Server would refuse to start (any provider + low RAM). */
  reindexRefused: boolean;
  reindexRefuseReason: string | null;
  estimatedVectorMb: number;
};

export type LibraryIndexStatus = {
  library: SearchLibrary;
  libraryLabel: string;
  totalItems: number;
  ftsCount: number;
  estimatedVectorMb: number;
  providers: ProviderIndexStatus[];
};

export type HostMemoryStatus = {
  memAvailableMb: number | null;
  largeLibraryItemThreshold: number;
  /** Shared critical floor — refuse any provider below this. */
  criticalMinAvailableMb: number;
  /** Large-library floor for Voyage/OpenAI/local. */
  remoteLargeMinAvailableMb: number;
  /** Large-library floor for Ollama (local model). */
  ollamaLargeMinAvailableMb: number;
};

export type SearchIndexStatus = {
  libraries: {
    saves: LibraryIndexStatus;
    likes: LibraryIndexStatus;
  };
  host: HostMemoryStatus;
  /** COUNT-only gap assessment (read-only). */
  gaps: SearchIndexGaps;
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
  memAvailableMb?: number | null,
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

  const memory: ReindexMemoryAssessment = assessReindexMemory(
    library,
    provider,
    total,
    memAvailableMb ?? readMemAvailableMb(),
  );

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
    reindexWarning: memory.warning,
    reindexStrongWarning: memory.strongWarning,
    reindexRefused: memory.refuse,
    reindexRefuseReason: memory.refuseReason,
    estimatedVectorMb: memory.estimatedVectorMb,
  };
}

function getLibraryIndexStatus(
  library: SearchLibrary,
  memAvailableMb: number | null,
): LibraryIndexStatus {
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
    estimatedVectorMb: estimatedVectorMegabytes(totalItems),
    providers: providers.map((provider) =>
      getProviderIndexStatus(library, provider, totalItems, memAvailableMb),
    ),
  };
}

export function getSearchIndexStatus(): SearchIndexStatus {
  // Reclaim/pump already-queued work only — never enqueue new backfill here.
  ensureJobRunner();
  const gaps = assessSearchIndexGaps();

  const memAvailableMb = readMemAvailableMb();
  const saves = getLibraryIndexStatus("saves", memAvailableMb);
  const likes = getLibraryIndexStatus("likes", memAvailableMb);

  return {
    libraries: { saves, likes },
    host: {
      memAvailableMb,
      largeLibraryItemThreshold: LARGE_LIBRARY_ITEM_THRESHOLD,
      criticalMinAvailableMb: CRITICAL_MIN_AVAILABLE_MB,
      remoteLargeMinAvailableMb: REMOTE_LARGE_MIN_AVAILABLE_MB,
      ollamaLargeMinAvailableMb: OLLAMA_LARGE_MIN_AVAILABLE_MB,
    },
    gaps,
    job: getDisplayEmbeddingJob(),
    pendingJobs: getPendingEmbeddingJobs(),
    recentJobs: getRecentEmbeddingJobs(8),
    cancelSupported: true,
  };
}

const STREAM_FULL_REFRESH_MS = 5_000;

type StreamStatusCache = {
  at: number;
  /** Whether an embedding job was active when the expensive snapshot was taken. */
  hadActive: boolean;
  status: SearchIndexStatus;
};

const globalForStatus = globalThis as unknown as {
  __searchStatusStreamCache?: StreamStatusCache | null;
};

/**
 * SSE-friendly status: refresh expensive vec COUNTs at most every ~5s
 * (active *and* idle). Between full refreshes, merge cheap job queue fields
 * into the last snapshot (progress ticks use job.processed/total).
 * Force a full refresh when activity flips (job start/stop) so coverage
 * catches up promptly after a rebuild finishes.
 */
export function getSearchIndexStatusForStream(): SearchIndexStatus {
  ensureJobRunner();
  const active = getActiveEmbeddingJob();
  const now = Date.now();
  const cache = globalForStatus.__searchStatusStreamCache ?? null;
  const isActive = Boolean(active);
  const activityFlipped = Boolean(cache && cache.hadActive !== isActive);

  if (
    !cache ||
    activityFlipped ||
    now - cache.at >= STREAM_FULL_REFRESH_MS
  ) {
    const status = getSearchIndexStatus();
    globalForStatus.__searchStatusStreamCache = {
      at: now,
      hadActive: isActive,
      status,
    };
    return status;
  }

  return {
    ...cache.status,
    job: getDisplayEmbeddingJob(),
    pendingJobs: getPendingEmbeddingJobs(),
    recentJobs: getRecentEmbeddingJobs(8),
  };
}
