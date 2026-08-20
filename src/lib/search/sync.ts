import { getStorage, type SearchIndex } from "../storage";
import {
  embeddingConfigForProvider,
  isRemoteEmbeddingConfigured,
  localEmbeddingConfig,
  type EmbeddingConfig,
  type EmbeddingProvider,
} from "./embeddings";
import {
  formatJobTarget,
  SEARCH_LIBRARIES,
  type SearchLibrary,
} from "./library";
import {
  createProgressThrottleEmitter,
  REBUILD_FORCE_PHASES,
} from "../progress-throttle";
import {
  ftsCount,
  upsertItemFts,
  upsertLikedItemFts,
} from "./sync-fts";
import {
  embeddingProfilesMatch,
  getIndexedEmbeddingProfile,
  vecCount,
  vectorIndexMatchesConfig,
  vectorTableDimensions,
} from "./sync-vec-store";
import {
  assessReindexMemory,
  estimatedVectorMegabytes,
  logReindexMemoryWarning,
} from "./memory";
import {
  configuredProviders,
  configuredRemoteProviders,
  isProviderConfigured,
} from "./providers";
import {
  allLikesSearchRows,
  allSavesSearchRows,
  type LikesSearchRow,
  type SavesSearchRow,
} from "./sync-rows";

import {
  EMBEDDING_SYNC_CHUNK_SIZE,
  RebuildCancelledError,
  canResumeVectorRebuild,
  existingEmbeddingItemIds,
  storeEmbeddingsChunked,
  storeLocalEmbeddingsChunked,
} from "./sync-embed";

export type { VectorIndexName, SearchLibrary } from "./library";
export {
  SQL_IN_CLAUSE_BATCH_SIZE,
  chunkIdsForSqlIn,
  allSavesSearchRows,
  allLikesSearchRows,
} from "./sync-rows";
export type { SavesSearchRow, LikesSearchRow } from "./sync-rows";
export {
  ftsCount,
  removeItemSearch,
  removeLikedItemSearch,
  upsertItemFts,
  upsertLikedItemFts,
} from "./sync-fts";
export {
  embeddingProfilesMatch,
  getIndexedEmbeddingProfile,
  getIndexedEmbeddingProfileMeta,
  insertItemEmbedding,
  upsertItemEmbedding,
  vecCount,
  vectorIndexMatchesConfig,
  vectorTableDimensions,
  writeEmbeddingChunk,
  type EmbeddingWriteMode,
  type IndexedEmbeddingProfileMeta,
} from "./sync-vec-store";

export {
  EMBEDDING_SYNC_CHUNK_SIZE,
  RebuildCancelledError,
} from "./sync-embed";

export type RebuildProgress = {
  phase: "preparing" | "fts" | "embedding" | "storing" | "done";
  processed: number;
  total: number;
  currentProvider?: EmbeddingProvider;
  message?: string;
};

export type RebuildProgressCallback = (
  progress: RebuildProgress,
) => void | Promise<void>;

export type EmbeddingSyncResult = {
  status: "updated" | "skipped";
  items: number;
  providers: string[];
  message: string;
};

async function canExtendRemoteIndex(
  library: SearchLibrary,
  provider: EmbeddingProvider,
  config: EmbeddingConfig,
  rows: Array<{ id: number }>,
  search: SearchIndex,
): Promise<boolean> {
  const indexed = await search.getIndexedEmbeddingProfile(library, provider);
  const totalItems =
    library === "saves"
      ? (await search.allSavesSearchRows()).length
      : (await search.allLikesSearchRows()).length;
  return (
    totalItems === rows.length ||
    Boolean(
      indexed &&
        embeddingProfilesMatch(indexed, config.profile) &&
        (await search.vectorTableDimensions(library, provider)) ===
          config.profile.dimensions &&
        (await search.vecCount(library, provider)) >= totalItems - rows.length,
    )
  );
}

async function syncSavesProviderIndex(
  provider: EmbeddingProvider,
  rows: SavesSearchRow[],
  replace: boolean,
  search: SearchIndex,
): Promise<{ updated: boolean; error?: string }> {
  const config = await embeddingConfigForProvider(provider);
  if (provider === "local") {
    await storeEmbeddingsChunked("saves", "local", rows, config, replace, search);
    return { updated: true };
  }

  if (provider !== "ollama" && !config.apiKey) return { updated: false };

  if (!replace && !(await canExtendRemoteIndex("saves", provider, config, rows, search))) {
    return {
      updated: false,
      error: `${provider} index provenance differs or is incomplete`,
    };
  }

  try {
    await storeEmbeddingsChunked("saves", provider, rows, config, replace, search);
    return { updated: true };
  } catch (error) {
    return {
      updated: false,
      error: error instanceof Error ? error.message : "unknown error",
    };
  }
}

async function syncLikesProviderIndex(
  provider: EmbeddingProvider,
  rows: LikesSearchRow[],
  replace: boolean,
  search: SearchIndex,
): Promise<{ updated: boolean; error?: string }> {
  const config = await embeddingConfigForProvider(provider);
  if (provider === "local") {
    await storeEmbeddingsChunked("likes", "local", rows, config, replace, search);
    return { updated: true };
  }

  if (provider !== "ollama" && !config.apiKey) return { updated: false };

  if (!replace && !(await canExtendRemoteIndex("likes", provider, config, rows, search))) {
    return {
      updated: false,
      error: `${provider} likes index provenance differs or is incomplete`,
    };
  }

  try {
    await storeEmbeddingsChunked("likes", provider, rows, config, replace, search);
    return { updated: true };
  } catch (error) {
    return {
      updated: false,
      error: error instanceof Error ? error.message : "unknown error",
    };
  }
}

async function formatSyncMessage(
  library: SearchLibrary,
  rowsLength: number,
  updatedProviders: string[],
  notes: string[],
  targets: EmbeddingProvider[],
): Promise<EmbeddingSyncResult> {
  const label = library === "saves" ? "items" : "likes";

  if (rowsLength === 0) {
    return {
      status: "updated",
      items: 0,
      providers: updatedProviders,
      message: `No changed ${label} needed semantic indexing.`,
    };
  }

  if (targets.length === 0) {
    return {
      status: "skipped",
      items: rowsLength,
      providers: [],
      message:
        "No embedding indexes are enabled — keyword (FTS) search still works. Enable providers in Settings.",
    };
  }

  const remoteConfigured = await configuredRemoteProviders(library);
  const remoteUpdated = remoteConfigured.filter((p) =>
    updatedProviders.includes(p),
  );
  const skippedRemote = remoteConfigured.filter(
    (p) => !updatedProviders.includes(p),
  );
  const localUpdated = updatedProviders.includes("local");

  let message = localUpdated
    ? `Offline semantic index updated for ${rowsLength} ${label === "likes" ? "like" : "item"}${rowsLength === 1 ? "" : "s"}`
    : `Semantic indexing for ${rowsLength} ${label === "likes" ? "like" : "item"}${rowsLength === 1 ? "" : "s"}`;
  if (remoteUpdated.length > 0) {
    message += `; ${remoteUpdated.join(", ")} indexes updated`;
  }
  if (skippedRemote.length > 0) {
    message += `; ${skippedRemote.join(", ")} skipped (${notes.join("; ") || "run pnpm run reindex"})`;
  }
  if (!localUpdated && remoteUpdated.length === 0 && skippedRemote.length === 0) {
    message += " (no enabled indexes updated)";
  }
  message += ".";

  return {
    status:
      skippedRemote.length > 0 && remoteUpdated.length === 0 && !localUpdated
        ? "skipped"
        : "updated",
    items: rowsLength,
    providers: updatedProviders,
    message,
  };
}

/**
 * Updates vector indexes only for explicitly enabled providers.
 * Disabled indexes are skipped even when API keys exist.
 * Network work for remotes runs outside long SQLite transactions.
 */
export async function syncItemEmbeddings(
  itemIds: number[],
): Promise<EmbeddingSyncResult> {
  const uniqueIds = [...new Set(itemIds)];
  const { search } = await getStorage();
  const rows = await search.allSavesSearchRows(uniqueIds);
  const updatedProviders: string[] = [];
  const notes: string[] = [];
  const targets = await configuredProviders("saves");

  for (const provider of targets) {
    const result = await syncSavesProviderIndex(provider, rows, false, search);
    if (result.updated) {
      updatedProviders.push(provider);
    } else if (result.error) {
      notes.push(`${provider}: ${result.error}`);
    }
  }

  return formatSyncMessage("saves", rows.length, updatedProviders, notes, targets);
}

export async function syncLikedItemEmbeddings(
  itemIds: number[],
): Promise<EmbeddingSyncResult> {
  const uniqueIds = [...new Set(itemIds)];
  const { search } = await getStorage();
  const rows = await search.allLikesSearchRows(uniqueIds);
  const updatedProviders: string[] = [];
  const notes: string[] = [];
  const targets = await configuredProviders("likes");

  for (const provider of targets) {
    const result = await syncLikesProviderIndex(provider, rows, false, search);
    if (result.updated) {
      updatedProviders.push(provider);
    } else if (result.error) {
      notes.push(`${provider}: ${result.error}`);
    }
  }

  return formatSyncMessage("likes", rows.length, updatedProviders, notes, targets);
}

async function assertProviderRebuildable(
  provider: EmbeddingProvider,
  library: SearchLibrary,
) {
  if (!(await isProviderConfigured(provider, library))) {
    throw new Error(
      `${provider} is not enabled for ${library} — turn it on in Settings (and add credentials if needed) before reindexing`,
    );
  }
  if (provider !== "local" && provider !== "ollama") {
    const config = await embeddingConfigForProvider(provider);
    if (!config.apiKey) {
      throw new Error(`${provider} API key is missing`);
    }
  }
}

async function emitProgress(
  onProgress: RebuildProgressCallback | undefined,
  progress: RebuildProgress,
) {
  await onProgress?.(progress);
}

function throwIfCancelled(shouldCancel?: () => boolean) {
  if (shouldCancel?.()) throw new RebuildCancelledError();
}

function createRebuildProgressEmitter(
  onProgress: RebuildProgressCallback | undefined,
): RebuildProgressCallback {
  return createProgressThrottleEmitter(onProgress, {
    forcePhases: REBUILD_FORCE_PHASES,
  });
}

/**
 * Rebuild a single provider's vector index with incremental progress.
 * Embedding network calls never run inside a SQLite write transaction.
 * Streams in chunks: embed chunk → write chunk → drop references.
 *
 * Resume (`options.resume`): when the job was interrupted mid-rebuild and the
 * stored embedding profile still matches, skip item_ids already present in the
 * vec table instead of DROP+recreate. Fresh jobs (`resume` false / processed 0)
 * always recreate. Cancel leaves a partial table; the next *new* job wipes it.
 */
export async function rebuildProviderIndex(
  library: SearchLibrary,
  provider: EmbeddingProvider,
  options?: {
    resume?: boolean;
    onProgress?: RebuildProgressCallback;
    shouldCancel?: () => boolean;
  },
): Promise<{ items: number }> {
  await assertProviderRebuildable(provider, library);

  const { search } = await getStorage();
  const config = await embeddingConfigForProvider(provider);
  const emit = createRebuildProgressEmitter(options?.onProgress);
  const shouldCancel = options?.shouldCancel;
  const targetLabel = formatJobTarget(library, provider);
  const rows =
    library === "saves"
      ? await search.allSavesSearchRows()
      : await search.allLikesSearchRows();
  const total = rows.length;
  const resumeRequested = Boolean(options?.resume);
  const resume =
    resumeRequested &&
    (await canResumeVectorRebuild(library, provider, config, search));

  logReindexMemoryWarning(assessReindexMemory(library, provider, total));

  let already = 0;
  if (resume) {
    const existing = await existingEmbeddingItemIds(library, provider, search);
    // Only ids still present in the library count as done, so `already` can
    // never exceed `total` after items were deleted.
    already = rows.filter((row) => existing.has(row.id)).length;
  }

  await emit({
    phase: "preparing",
    processed: already,
    total,
    currentProvider: provider,
    message: resume
      ? `Resuming ${targetLabel} index (${already}/${total} already embedded)…`
      : `Preparing ${targetLabel} index…`,
  });
  throwIfCancelled(shouldCancel);

  // Fresh start always replaces; resume keeps the table and skips existing ids.
  await storeEmbeddingsChunked(
    library,
    provider,
    rows,
    config,
    !resume,
    search,
    {
      resume,
      shouldCancel,
      onChunk: async (processed, chunkTotal) => {
        await emit({
          phase: "embedding",
          processed,
          total: chunkTotal,
          currentProvider: provider,
          message: resume
            ? `Resumed ${targetLabel} ${processed}/${chunkTotal}`
            : `Embedded ${targetLabel} ${processed}/${chunkTotal}`,
        });
      },
    },
  );

  await emit({
    phase: "done",
    processed: total,
    total,
    currentProvider: provider,
    message: `${targetLabel} index rebuilt (${total} items)`,
  });

  return { items: total };
}

/**
 * Rebuild FTS for both libraries, then every enabled provider for both.
 * Network calls never hold a transaction.
 */
export async function rebuildConfiguredIndexes(options?: {
  onProgress?: RebuildProgressCallback;
  shouldCancel?: () => boolean;
  requireRemote?: boolean;
}): Promise<{
  items: number;
  providers: string[];
  remoteUpdated: string[];
}> {
  if (options?.requireRemote && !(await isRemoteEmbeddingConfigured())) {
    throw new Error(
      "--remote requires at least one enabled neural provider (OpenAI/Voyage with keys, and/or Ollama)",
    );
  }

  const { search } = await getStorage();
  const savesRows = await search.allSavesSearchRows();
  const likesRows = await search.allLikesSearchRows();
  const onProgress = options?.onProgress;
  const shouldCancel = options?.shouldCancel;
  const pairs: Array<{ library: SearchLibrary; provider: EmbeddingProvider }> =
    [];
  for (const library of SEARCH_LIBRARIES) {
    for (const provider of await configuredProviders(library)) {
      pairs.push({ library, provider });
    }
  }
  const providers = [...new Set(pairs.map((p) => p.provider))];
  const totalItems = savesRows.length + likesRows.length;

  await emitProgress(onProgress, {
    phase: "fts",
    processed: 0,
    total: Math.max(1, totalItems * Math.max(1, Math.max(1, pairs.length))),
    message: "Rebuilding keyword (FTS) indexes…",
  });
  throwIfCancelled(shouldCancel);

  for (const row of savesRows) await search.upsertItemFts(row.id, row);
  for (const row of likesRows) await search.upsertLikedItemFts(row.id, row);

  const remoteUpdated: string[] = [];
  const overallTotal = Math.max(1, pairs.reduce((sum, pair) => {
    const libraryTotal =
      pair.library === "saves" ? savesRows.length : likesRows.length;
    return sum + libraryTotal;
  }, 0) || totalItems);
  let overallBase = 0;

  for (const { library, provider } of pairs) {
    throwIfCancelled(shouldCancel);
    const libraryTotal =
      library === "saves" ? savesRows.length : likesRows.length;
    await rebuildProviderIndex(library, provider, {
      onProgress: async (progress) => {
        await emitProgress(onProgress, {
          ...progress,
          processed: overallBase + progress.processed,
          total: overallTotal,
        });
      },
      shouldCancel,
    });
    overallBase += libraryTotal;
    if (provider !== "local" && !remoteUpdated.includes(provider)) {
      remoteUpdated.push(provider);
    }
  }

  await emitProgress(onProgress, {
    phase: "done",
    processed: overallTotal,
    total: overallTotal,
    message: `Rebuilt FTS and ${providers.join(", ") || "no vector indexes"} for saves + likes`,
  });

  return {
    items: totalItems,
    providers,
    remoteUpdated,
  };
}

/**
 * Rebuild FTS, then every enabled provider index for both libraries.
 */
export async function rebuildSearchIndex(options?: {
  requireRemote?: boolean;
  onProgress?: RebuildProgressCallback;
  shouldCancel?: () => boolean;
}): Promise<{
  items: number;
  providers: string[];
  remoteUpdated: string[];
}> {
  return rebuildConfiguredIndexes(options);
}

/**
 * Rebuild keyword (FTS) indexes for saves + likes when coverage lags item
 * counts. Incremental: only runs when `ftsCount < itemCount`. Used by the
 * `fts` embedding job and by `ensureSearchIndexBackfill` (CLI / explicit).
 * Never call from browse/list/stats read paths.
 */
export async function rebuildKeywordIndexes(options?: {
  onProgress?: RebuildProgressCallback;
  shouldCancel?: () => boolean;
}): Promise<{ saves: number; likes: number; rebuilt: boolean }> {
  const { search } = await getStorage();
  const savesRows = await search.allSavesSearchRows();
  const likesRows = await search.allLikesSearchRows();
  const savesGap =
    savesRows.length > 0 && (await search.ftsCount("saves")) < savesRows.length;
  const likesGap =
    likesRows.length > 0 && (await search.ftsCount("likes")) < likesRows.length;
  const total = savesRows.length + likesRows.length;

  await emitProgress(options?.onProgress, {
    phase: "fts",
    processed: 0,
    total: Math.max(1, total),
    message: savesGap || likesGap
      ? "Rebuilding keyword (FTS) indexes…"
      : "Keyword indexes already current",
  });
  throwIfCancelled(options?.shouldCancel);

  if (!savesGap && !likesGap) {
    await emitProgress(options?.onProgress, {
      phase: "done",
      processed: total,
      total: Math.max(1, total),
      message: "Keyword indexes already current",
    });
    return { saves: savesRows.length, likes: likesRows.length, rebuilt: false };
  }

  if (savesGap) {
    for (const row of savesRows) await search.upsertItemFts(row.id, row);
  }
  if (likesGap) {
    for (const row of likesRows) await search.upsertLikedItemFts(row.id, row);
  }

  throwIfCancelled(options?.shouldCancel);
  await emitProgress(options?.onProgress, {
    phase: "done",
    processed: total,
    total: Math.max(1, total),
    message: `Keyword indexes updated (saves ${savesRows.length}, likes ${likesRows.length})`,
  });

  return { saves: savesRows.length, likes: likesRows.length, rebuilt: true };
}

/** Backfill keyword index; local vectors only when the local index is enabled. */
export async function ensureSearchIndexBackfill() {
  const { search } = await getStorage();
  const savesRows = await search.allSavesSearchRows();
  const likesRows = await search.allLikesSearchRows();

  if (savesRows.length > 0 && (await search.ftsCount("saves")) < savesRows.length) {
    for (const row of savesRows) await search.upsertItemFts(row.id, row);
  }

  if (likesRows.length > 0 && (await search.ftsCount("likes")) < likesRows.length) {
    for (const row of likesRows) await search.upsertLikedItemFts(row.id, row);
  }

  const localConfig = localEmbeddingConfig();

  if (
    (await isProviderConfigured("local", "saves")) &&
    savesRows.length > 0 &&
    !(
      (await search.vecCount("saves", "local")) >= savesRows.length &&
      (await search.vectorIndexMatchesConfig("saves", "local", localConfig))
    )
  ) {
    await storeLocalEmbeddingsChunked("saves", savesRows, localConfig, search);
  }

  if (
    (await isProviderConfigured("local", "likes")) &&
    likesRows.length > 0 &&
    !(
      (await search.vecCount("likes", "local")) >= likesRows.length &&
      (await search.vectorIndexMatchesConfig("likes", "local", localConfig))
    )
  ) {
    if (likesRows.length >= 20_000) {
      console.warn(
        `[search] Local likes backfill for ${likesRows.length} items ` +
          `(~${estimatedVectorMegabytes(likesRows.length).toFixed(0)} MB vectors) streaming in chunks of ${EMBEDDING_SYNC_CHUNK_SIZE}.`,
      );
    }
      await storeLocalEmbeddingsChunked("likes", likesRows, localConfig, search);
  }
}
