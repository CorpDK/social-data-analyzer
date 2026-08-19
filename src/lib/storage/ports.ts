/**
 * Async storage ports for multi-engine support.
 *
 * SQLite is the first implementation; Postgres arrives in ME-4.
 * App call sites await these ports via `getStorage()`.
 */
import type { FileSchemaCatalogEntry } from "../json-schema-infer";
import type { ParsedLikedItem, ParsedSavedItem } from "../parse-export";
import type { PersistedImportCounts } from "../import/partial-accounting";
import type { ImportRollbackResult } from "../import/rollback-partial";
import type { ImportRunOptions } from "../import/types";
import type { ImportJobRecord, ImportJobsStatus } from "../import/jobs";
import type {
  SchemaCatalogResult,
  SchemaFileEntry,
  SchemaImportOption,
} from "../schema-catalog";
import type {
  AppSettingKey,
  PreferredProvider,
  RuntimeAppSettings,
  SearchLibrarySetting,
  LibraryEnables,
} from "../settings/app-settings";
import type {
  DbMaintenanceAction,
  DbMaintenanceResult,
} from "../settings/db-maintenance";
import type { LibraryBusyState } from "../settings/library-busy";
import type { ResetLibraryResult } from "../settings/reset-library";
import type {
  EmbeddingConfig,
  EmbeddingProfile,
} from "../search/embeddings";
import type { SearchLibrary, VectorIndexName } from "../search/library";
import type {
  EmbeddingJobRecord,
  EmbeddingJobTarget,
} from "../search/jobs-records";
import type { SearchIndexGaps } from "../search/readiness";
import type {
  LikedSearchableItem,
  SearchableItem,
} from "../search/document";
import type {
  EmbeddingWriteMode,
  IndexedEmbeddingProfileMeta,
} from "../search/sync-vec-store";
import type { LikesSearchRow, SavesSearchRow } from "../search/sync-rows";
import type { VecIntegrityReport } from "../search/vec-integrity";
import type {
  EmbeddingReclaimResult,
  ImportReclaimResult,
} from "../job-queue";
import type { SavesQuery, LikesQuery } from "../queries";

/** Engine capability descriptor for maintenance + search UI copy (ME-4 expands). */
export type EngineInfo = {
  engine: "sqlite" | "postgres";
  displayName: string;
  /** Maintenance actions this engine supports. */
  maintenanceActions: DbMaintenanceAction[];
  searchTech: {
    keyword: string;
    vector: string;
  };
  supportsWalCheckpoint: boolean;
  supportsVacuum: boolean;
};

export type CatalogStats = ReturnType<
  typeof import("../queries").getStats
>;

export type CatalogListSavesResult = Awaited<
  ReturnType<typeof import("../queries").listSaves>
>;

export type CatalogListLikesResult = Awaited<
  ReturnType<typeof import("../queries").listLikes>
>;

export type ApplyParsedItemsResult = Awaited<
  ReturnType<typeof import("../import/write-batches").applyParsedItems>
>;

export type ApplyLikedItemsResult = Awaited<
  ReturnType<typeof import("../import/write-batches").applyLikedItems>
>;

/**
 * Relational catalog: browse/stats, schema catalog, import persistence.
 * Batch transactions stay inside the engine implementation.
 */
export interface CatalogStore {
  getStats(): Promise<CatalogStats>;
  listSaves(query: SavesQuery): Promise<CatalogListSavesResult>;
  listLikes(query: LikesQuery): Promise<CatalogListLikesResult>;
  listImports(): Promise<ReturnType<typeof import("../queries").listImports>>;
  getImportById(
    id: number,
  ): Promise<ReturnType<typeof import("../queries").getImportById>>;
  listSavesFilterOptions(): Promise<
    ReturnType<typeof import("../queries").listSavesFilterOptions>
  >;
  listLikesFilterOptions(): Promise<
    ReturnType<typeof import("../queries").listLikesFilterOptions>
  >;

  listSchemaImportOptions(): Promise<SchemaImportOption[]>;
  getSchemasForImport(importId: number): Promise<SchemaFileEntry[]>;
  getAggregatedSchemas(): Promise<SchemaFileEntry[]>;
  getSchemaCatalog(
    importIdParam: string | null | undefined,
  ): Promise<SchemaCatalogResult>;

  persistImportSchemas(
    importId: number,
    catalog: FileSchemaCatalogEntry[],
  ): Promise<void>;
  applyParsedItems(
    importId: number,
    items: ParsedSavedItem[],
    options?: ImportRunOptions,
  ): Promise<ApplyParsedItemsResult>;
  applyLikedItems(
    importId: number,
    items: ParsedLikedItem[],
    options?: ImportRunOptions,
  ): Promise<ApplyLikedItemsResult>;
  appendImportNotes(importId: number, extra: string): Promise<void>;
  countPersistedImportRows(importId: number): Promise<PersistedImportCounts>;
  rollbackImportInserts(importId: number): Promise<ImportRollbackResult>;
  discardImportInserts(importId: number): Promise<ImportRollbackResult>;
}

/**
 * FTS + vector index primitives. Engine-neutral RRF / rebuild orchestration
 * stays shared and calls into this port.
 */
export interface SearchIndex {
  upsertItemFts(itemId: number, item: SearchableItem): Promise<void>;
  upsertLikedItemFts(itemId: number, item: LikedSearchableItem): Promise<void>;
  removeItemSearch(itemId: number): Promise<void>;
  removeLikedItemSearch(itemId: number): Promise<void>;
  ftsCount(library?: SearchLibrary): Promise<number>;

  recreateVectorTable(
    library: SearchLibrary,
    index: VectorIndexName,
    dimensions: number,
  ): Promise<void>;
  writeEmbeddingProfile(
    library: SearchLibrary,
    index: VectorIndexName,
    profile: EmbeddingProfile,
  ): Promise<void>;
  insertItemEmbedding(
    library: SearchLibrary,
    index: VectorIndexName,
    itemId: number,
    embedding: Float32Array,
  ): Promise<void>;
  upsertItemEmbedding(
    library: SearchLibrary,
    index: VectorIndexName,
    itemId: number,
    embedding: Float32Array,
  ): Promise<void>;
  vecCount(library: SearchLibrary, index: VectorIndexName): Promise<number>;
  vectorTableDimensions(
    library: SearchLibrary,
    index: VectorIndexName,
  ): Promise<number | null>;
  getIndexedEmbeddingProfileMeta(
    library: SearchLibrary,
    index: VectorIndexName,
  ): Promise<IndexedEmbeddingProfileMeta | null>;
  getIndexedEmbeddingProfile(
    library: SearchLibrary,
    index: VectorIndexName,
  ): Promise<EmbeddingProfile | null>;
  vectorIndexMatchesConfig(
    library: SearchLibrary,
    index: VectorIndexName,
    config: EmbeddingConfig,
  ): Promise<boolean>;
  writeEmbeddingChunk(
    library: SearchLibrary,
    index: VectorIndexName,
    generated: Array<{ id: number; embedding: Float32Array }>,
    writeMode: EmbeddingWriteMode,
  ): Promise<void>;

  allSavesSearchRows(itemIds?: number[]): Promise<SavesSearchRow[]>;
  allLikesSearchRows(itemIds?: number[]): Promise<LikesSearchRow[]>;

  searchFts(
    library: SearchLibrary,
    query: string,
    limit?: number,
  ): Promise<{ hits: Array<{ id: number; rank: number }>; degraded: boolean }>;

  assessVectorIntegrity(
    library: SearchLibrary,
    index: VectorIndexName,
    options?: { sampleLimit?: number },
  ): Promise<VecIntegrityReport>;
  assessSearchIndexGaps(): Promise<SearchIndexGaps>;
}

/**
 * Job row CRUD + reclaim. Runner/spawn policy stays outside the port.
 */
export interface JobStore {
  getEmbeddingJob(id: number): Promise<EmbeddingJobRecord | null>;
  getLatestEmbeddingJob(): Promise<EmbeddingJobRecord | null>;
  getLatestFinishedEmbeddingJob(): Promise<EmbeddingJobRecord | null>;
  getActiveEmbeddingJob(): Promise<EmbeddingJobRecord | null>;
  getPendingEmbeddingJobs(): Promise<EmbeddingJobRecord[]>;
  getRecentEmbeddingJobs(limit?: number): Promise<EmbeddingJobRecord[]>;
  listEmbeddingJobs(options?: {
    limit?: number;
    offset?: number;
  }): Promise<{
    jobs: EmbeddingJobRecord[];
    total: number;
    limit: number;
    offset: number;
  }>;
  getDisplayEmbeddingJob(): Promise<EmbeddingJobRecord | null>;
  getOpenJobForTarget(
    target: EmbeddingJobTarget,
  ): Promise<EmbeddingJobRecord | null>;
  hasOpenEmbeddingJobForTarget(target: EmbeddingJobTarget): Promise<boolean>;

  getImportJob(id: number): Promise<ImportJobRecord | null>;
  getActiveImportJob(): Promise<ImportJobRecord | null>;
  getPendingImportJobs(): Promise<ImportJobRecord[]>;
  getLatestFinishedImportJob(): Promise<ImportJobRecord | null>;
  getDisplayImportJob(): Promise<ImportJobRecord | null>;
  getRecentImportJobs(limit?: number): Promise<ImportJobRecord[]>;
  getImportJobsStatus(): Promise<ImportJobsStatus>;

  reclaimOrphanedEmbeddingJobs(): Promise<EmbeddingReclaimResult>;
  reclaimOrphanedImportJobs(): Promise<ImportReclaimResult>;
}

/**
 * app_settings KV. Env-fallback resolution stays in shared helpers used by
 * the SQLite adapter (and later Postgres).
 */
export interface SettingsStore {
  getAppSetting(key: AppSettingKey): Promise<string | null>;
  setAppSetting(key: AppSettingKey, value: string | null): Promise<void>;
  getRuntimeAppSettings(): Promise<RuntimeAppSettings>;
  getPreferredEmbeddingProvider(): Promise<PreferredProvider | null>;
  getEmbeddingTimeoutMs(): Promise<number>;
  getProviderLibraryEnables(
    provider: PreferredProvider,
  ): Promise<LibraryEnables>;
  setProviderLibraryEnabled(
    provider: PreferredProvider,
    library: SearchLibrarySetting,
    enabled: boolean,
  ): Promise<void>;
  isProviderIndexEnabled(
    provider: PreferredProvider,
    library: SearchLibrarySetting,
  ): Promise<boolean>;
}

export interface MaintenanceOps {
  engineInfo(): Promise<EngineInfo>;
  getLibraryBusyState(operation?: string): Promise<LibraryBusyState>;
  runMaintenance(action: DbMaintenanceAction): Promise<DbMaintenanceResult>;
  resetLibrary(confirmation: string): Promise<ResetLibraryResult>;
  checkIntegrity(): Promise<{ ok: boolean; detail: string }>;
}

/** Bundled storage handle returned by getStorage(). */
export type Storage = {
  catalog: CatalogStore;
  search: SearchIndex;
  jobs: JobStore;
  settings: SettingsStore;
  maintenance: MaintenanceOps;
};
