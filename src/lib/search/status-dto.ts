/**
 * Client-safe wire types for search index status + embedding jobs.
 * Pure types only — safe to import from `"use client"` modules.
 * Server modules re-export / implement these shapes (see status.ts, jobs.ts).
 */

export type EmbeddingProvider = "local" | "ollama" | "openai" | "voyage";
export type SearchLibrary = "saves" | "likes";

/** Provider picker payload returned with browse/search API responses. */
export type SearchProviderInfoDto = {
  available: EmbeddingProvider[];
  configured: Record<EmbeddingProvider, boolean>;
  enabled?: Record<EmbeddingProvider, boolean>;
  default: EmbeddingProvider;
};
export type IndexHealth =
  | "ready"
  | "partial"
  | "stale"
  | "empty"
  | "unavailable";

export type EmbeddingJobState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type EmbeddingJobPhase =
  | "queued"
  | "preparing"
  | "fts"
  | "embedding"
  | "storing"
  | "done";

/** Wire shape of an embedding_jobs row (matches EmbeddingJobRecord on the server). */
export type EmbeddingJobDto = {
  id: number;
  target: string;
  state: EmbeddingJobState;
  phase: string;
  processed: number;
  total: number;
  percent: number;
  currentProvider: string | null;
  error: string | null;
  message: string | null;
  cancelRequested: boolean;
  startedAt: number;
  finishedAt: number | null;
  updatedAt: number;
};

export type EmbeddingProfileDto = {
  provider: string;
  model: string;
  dimensions: number;
  endpoint: string | null;
  updatedAt?: number | null;
};

export type ProviderIndexStatusDto = {
  library: SearchLibrary;
  libraryLabel: string;
  target: string;
  provider: EmbeddingProvider;
  enabled: boolean;
  hasCredentials: boolean;
  configured: boolean;
  indexPresent: boolean;
  totalItems: number;
  embeddedCount: number;
  coveragePercent: number;
  health: IndexHealth;
  hint: string | null;
  stored: EmbeddingProfileDto | null;
  expected: EmbeddingProfileDto | null;
  tableDimensions: number | null;
  reindexWarning?: string | null;
  reindexStrongWarning?: string | null;
  reindexRefused?: boolean;
  reindexRefuseReason?: string | null;
  estimatedVectorMb?: number;
};

export type LibraryIndexStatusDto = {
  library: SearchLibrary;
  libraryLabel: string;
  totalItems: number;
  ftsCount: number;
  estimatedVectorMb?: number;
  providers: ProviderIndexStatusDto[];
};

export type HostMemoryStatusDto = {
  memAvailableMb: number | null;
  largeLibraryItemThreshold: number;
  criticalMinAvailableMb: number;
  remoteLargeMinAvailableMb: number;
  ollamaLargeMinAvailableMb: number;
};

/** `/api/search/status` (and SSE snapshot) payload. */
export type SearchIndexStatusDto = {
  libraries: {
    saves: LibraryIndexStatusDto;
    likes: LibraryIndexStatusDto;
  };
  host: HostMemoryStatusDto;
  /** COUNT-only coverage gaps — GET is read-only; heal via POST. */
  gaps?: {
    savesFtsGap: number;
    likesFtsGap: number;
    savesLocalGap: boolean;
    likesLocalGap: boolean;
    degraded: boolean;
  };
  job: EmbeddingJobDto | null;
  pendingJobs: EmbeddingJobDto[];
  recentJobs?: EmbeddingJobDto[];
  cancelSupported: boolean;
};
