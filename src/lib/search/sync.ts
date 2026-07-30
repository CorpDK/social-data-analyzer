import type Database from "better-sqlite3";
import { getSqlite } from "../db";
import {
  buildLikedSearchDocument,
  buildSearchDocument,
  type LikedSearchableItem,
  type SearchableItem,
} from "./document";
import {
  embedText,
  embedTextLocal,
  embeddingConfigForProvider,
  embeddingToBuffer,
  isRemoteEmbeddingConfigured,
  localEmbeddingConfig,
  type EmbeddingConfig,
  type EmbeddingProfile,
  type EmbeddingProvider,
} from "./embeddings";
import {
  ALL_VECTOR_INDEXES,
  formatJobTarget,
  itemsTableName,
  profileIndexName,
  SEARCH_LIBRARIES,
  type SearchLibrary,
  type VectorIndexName,
  vectorTableName,
} from "./library";
import {
  configuredProviders,
  configuredRemoteProviders,
  isProviderConfigured,
} from "./providers";

export type { VectorIndexName, SearchLibrary } from "./library";

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

export class RebuildCancelledError extends Error {
  constructor(message = "Reindex cancelled") {
    super(message);
    this.name = "RebuildCancelledError";
  }
}

type SavesSearchRow = SearchableItem & { id: number };
type LikesSearchRow = LikedSearchableItem & { id: number };

export type EmbeddingSyncResult = {
  status: "updated" | "skipped";
  items: number;
  providers: string[];
  message: string;
};

function allSavesSearchRows(
  sqlite: Database.Database = getSqlite(),
  itemIds?: number[],
): SavesSearchRow[] {
  if (itemIds?.length === 0) return [];
  const where = itemIds
    ? `WHERE si.id IN (${itemIds.map(() => "?").join(", ")})`
    : "";
  return sqlite
    .prepare(
      `SELECT
        si.id,
        si.author_username AS authorUsername,
        si.shortcode AS shortcode,
        si.media_key AS mediaKey,
        si.media_type AS mediaType,
        COALESCE(group_concat(ic.collection_name, char(31)), '') AS collections
      FROM saved_items si
      LEFT JOIN item_collections ic ON ic.item_id = si.id
      ${where}
      GROUP BY si.id`,
    )
    .all(...(itemIds ?? []))
    .map((row) => {
      const typed = row as Omit<SavesSearchRow, "collections"> & {
        collections: string;
      };
      return {
        ...typed,
        collections: typed.collections
          ? typed.collections.split("\u001f").filter(Boolean)
          : [],
      };
    });
}

function allLikesSearchRows(
  sqlite: Database.Database = getSqlite(),
  itemIds?: number[],
): LikesSearchRow[] {
  if (itemIds?.length === 0) return [];
  const where = itemIds
    ? `WHERE id IN (${itemIds.map(() => "?").join(", ")})`
    : "";
  return sqlite
    .prepare(
      `SELECT
        id,
        author_username AS authorUsername,
        shortcode AS shortcode,
        media_key AS mediaKey,
        media_type AS mediaType,
        source AS source
      FROM liked_items
      ${where}`,
    )
    .all(...(itemIds ?? [])) as LikesSearchRow[];
}

export function upsertItemFts(
  itemId: number,
  item: SearchableItem,
  sqlite: Database.Database = getSqlite(),
) {
  const doc = buildSearchDocument(item);
  sqlite.prepare(`DELETE FROM saved_items_fts WHERE rowid = ?`).run(itemId);
  sqlite
    .prepare(
      `INSERT INTO saved_items_fts(
        rowid, author_username, shortcode, media_key, media_type, collections
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      itemId,
      doc.authorUsername,
      doc.shortcode,
      doc.mediaKey,
      doc.mediaType,
      doc.collections,
    );
}

export function upsertLikedItemFtsDoc(
  itemId: number,
  item: LikedSearchableItem,
  sqlite: Database.Database = getSqlite(),
) {
  const doc = buildLikedSearchDocument(item);
  sqlite.prepare(`DELETE FROM liked_items_fts WHERE rowid = ?`).run(itemId);
  sqlite
    .prepare(
      `INSERT INTO liked_items_fts(
        rowid, author_username, shortcode, media_key, media_type, source
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      itemId,
      doc.authorUsername,
      doc.shortcode,
      doc.mediaKey,
      doc.mediaType,
      doc.source,
    );
}

export function upsertItemEmbedding(
  library: SearchLibrary,
  index: VectorIndexName,
  itemId: number,
  embedding: Float32Array,
  sqlite: Database.Database = getSqlite(),
) {
  const table = vectorTableName(library, index);
  const id = BigInt(itemId);
  sqlite.prepare(`DELETE FROM ${table} WHERE item_id = ?`).run(id);
  sqlite
    .prepare(`INSERT INTO ${table}(item_id, embedding) VALUES (?, ?)`)
    .run(id, embeddingToBuffer(embedding));
}

/** @deprecated Prefer upsertItemEmbedding("saves", …). Kept for call sites. */
export function upsertSavesItemEmbedding(
  index: VectorIndexName,
  itemId: number,
  embedding: Float32Array,
  sqlite: Database.Database = getSqlite(),
) {
  upsertItemEmbedding("saves", index, itemId, embedding, sqlite);
}

export function removeItemSearch(
  itemId: number,
  sqlite: Database.Database = getSqlite(),
) {
  sqlite.prepare(`DELETE FROM saved_items_fts WHERE rowid = ?`).run(itemId);
  for (const index of ALL_VECTOR_INDEXES) {
    if (vectorTableDimensions("saves", index, sqlite) !== null) {
      sqlite
        .prepare(
          `DELETE FROM ${vectorTableName("saves", index)} WHERE item_id = ?`,
        )
        .run(BigInt(itemId));
    }
  }
}

export function removeLikedItemSearch(
  itemId: number,
  sqlite: Database.Database = getSqlite(),
) {
  sqlite.prepare(`DELETE FROM liked_items_fts WHERE rowid = ?`).run(itemId);
  for (const index of ALL_VECTOR_INDEXES) {
    if (vectorTableDimensions("likes", index, sqlite) !== null) {
      sqlite
        .prepare(
          `DELETE FROM ${vectorTableName("likes", index)} WHERE item_id = ?`,
        )
        .run(BigInt(itemId));
    }
  }
}

export function ftsCount(
  library: SearchLibrary = "saves",
  sqlite: Database.Database = getSqlite(),
): number {
  const table = library === "saves" ? "saved_items_fts" : "liked_items_fts";
  return (
    sqlite.prepare(`SELECT count(*) AS c FROM ${table}`).get() as {
      c: number;
    }
  ).c;
}

export function vecCount(
  library: SearchLibrary,
  index: VectorIndexName,
  sqlite: Database.Database = getSqlite(),
): number {
  if (vectorTableDimensions(library, index, sqlite) === null) return 0;
  return (
    sqlite
      .prepare(
        `SELECT count(*) AS c FROM ${vectorTableName(library, index)}`,
      )
      .get() as { c: number }
  ).c;
}

/** Saves-only overload used by older call sites that pass just the index. */
export function vecCountSaves(
  index: VectorIndexName,
  sqlite: Database.Database = getSqlite(),
): number {
  return vecCount("saves", index, sqlite);
}

export function vectorTableDimensions(
  library: SearchLibrary,
  index: VectorIndexName,
  sqlite: Database.Database = getSqlite(),
): number | null {
  const row = sqlite
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'table' AND name = ?`,
    )
    .get(vectorTableName(library, index)) as
    | { sql: string | null }
    | undefined;
  const match = row?.sql?.match(/embedding\s+FLOAT\[(\d+)\]/i);
  return match ? Number(match[1]) : null;
}

function recreateVectorTable(
  library: SearchLibrary,
  index: VectorIndexName,
  dimensions: number,
  sqlite: Database.Database,
) {
  const table = vectorTableName(library, index);
  sqlite.exec(`
    DROP TABLE IF EXISTS ${table};
    CREATE VIRTUAL TABLE ${table} USING vec0(
      item_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    );
  `);
}

export type IndexedEmbeddingProfileMeta = EmbeddingProfile & {
  updatedAt: number;
};

export function getIndexedEmbeddingProfileMeta(
  library: SearchLibrary,
  index: VectorIndexName,
  sqlite: Database.Database = getSqlite(),
): IndexedEmbeddingProfileMeta | null {
  const row = sqlite
    .prepare(
      `SELECT provider, model, dimensions, endpoint, updated_at AS updatedAt
       FROM embedding_index_profiles WHERE index_name = ?`,
    )
    .get(profileIndexName(library, index)) as
    | IndexedEmbeddingProfileMeta
    | undefined;
  return row ?? null;
}

export function getIndexedEmbeddingProfile(
  library: SearchLibrary,
  index: VectorIndexName,
  sqlite: Database.Database = getSqlite(),
): EmbeddingProfile | null {
  const meta = getIndexedEmbeddingProfileMeta(library, index, sqlite);
  if (!meta) return null;
  return {
    provider: meta.provider,
    model: meta.model,
    dimensions: meta.dimensions,
    endpoint: meta.endpoint,
  };
}

export function embeddingProfilesMatch(
  left: EmbeddingProfile,
  right: EmbeddingProfile,
): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.dimensions === right.dimensions &&
    left.endpoint === right.endpoint
  );
}

function writeEmbeddingProfile(
  library: SearchLibrary,
  index: VectorIndexName,
  profile: EmbeddingProfile,
  sqlite: Database.Database,
) {
  sqlite
    .prepare(
      `INSERT INTO embedding_index_profiles(
        index_name, provider, model, dimensions, endpoint, updated_at
      ) VALUES (?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(index_name) DO UPDATE SET
        provider = excluded.provider,
        model = excluded.model,
        dimensions = excluded.dimensions,
        endpoint = excluded.endpoint,
        updated_at = unixepoch()`,
    )
    .run(
      profileIndexName(library, index),
      profile.provider,
      profile.model,
      profile.dimensions,
      profile.endpoint,
    );
}

export function vectorIndexMatchesConfig(
  library: SearchLibrary,
  index: VectorIndexName,
  config: EmbeddingConfig,
  sqlite: Database.Database = getSqlite(),
): boolean {
  const indexed = getIndexedEmbeddingProfile(library, index, sqlite);
  return Boolean(
    indexed &&
      vecCount(library, index, sqlite) > 0 &&
      vectorTableDimensions(library, index, sqlite) ===
        config.profile.dimensions &&
      embeddingProfilesMatch(indexed, config.profile),
  );
}

async function generateSavesEmbeddings(
  rows: SavesSearchRow[],
  config: EmbeddingConfig,
) {
  const generated: Array<{ id: number; embedding: Float32Array }> = [];
  for (const row of rows) {
    generated.push({
      id: row.id,
      embedding: await embedText(buildSearchDocument(row).combined, config),
    });
  }
  return generated;
}

async function generateLikesEmbeddings(
  rows: LikesSearchRow[],
  config: EmbeddingConfig,
) {
  const generated: Array<{ id: number; embedding: Float32Array }> = [];
  for (const row of rows) {
    generated.push({
      id: row.id,
      embedding: await embedText(
        buildLikedSearchDocument(row).combined,
        config,
      ),
    });
  }
  return generated;
}

function storeEmbeddings(
  library: SearchLibrary,
  index: VectorIndexName,
  generated: Array<{ id: number; embedding: Float32Array }>,
  config: EmbeddingConfig,
  replace: boolean,
  sqlite: Database.Database,
) {
  sqlite.transaction(() => {
    if (
      replace ||
      vectorTableDimensions(library, index, sqlite) !==
        config.profile.dimensions
    ) {
      recreateVectorTable(library, index, config.profile.dimensions, sqlite);
    }
    for (const result of generated) {
      upsertItemEmbedding(library, index, result.id, result.embedding, sqlite);
    }
    writeEmbeddingProfile(library, index, config.profile, sqlite);
  })();
}

function canExtendRemoteIndex(
  library: SearchLibrary,
  provider: EmbeddingProvider,
  config: EmbeddingConfig,
  rows: Array<{ id: number }>,
  sqlite: Database.Database,
): boolean {
  const indexed = getIndexedEmbeddingProfile(library, provider, sqlite);
  const totalItems = (
    sqlite
      .prepare(`SELECT count(*) AS c FROM ${itemsTableName(library)}`)
      .get() as { c: number }
  ).c;
  return (
    totalItems === rows.length ||
    Boolean(
      indexed &&
        embeddingProfilesMatch(indexed, config.profile) &&
        vectorTableDimensions(library, provider, sqlite) ===
          config.profile.dimensions &&
        vecCount(library, provider, sqlite) >= totalItems - rows.length,
    )
  );
}

async function syncSavesProviderIndex(
  provider: EmbeddingProvider,
  rows: SavesSearchRow[],
  replace: boolean,
  sqlite: Database.Database,
): Promise<{ updated: boolean; error?: string }> {
  const config = embeddingConfigForProvider(provider);
  if (provider === "local") {
    const generated = await generateSavesEmbeddings(rows, config);
    storeEmbeddings("saves", "local", generated, config, replace, sqlite);
    return { updated: true };
  }

  if (provider !== "ollama" && !config.apiKey) return { updated: false };

  if (!replace && !canExtendRemoteIndex("saves", provider, config, rows, sqlite)) {
    return {
      updated: false,
      error: `${provider} index provenance differs or is incomplete`,
    };
  }

  try {
    const generated = await generateSavesEmbeddings(rows, config);
    storeEmbeddings("saves", provider, generated, config, replace, sqlite);
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
  sqlite: Database.Database,
): Promise<{ updated: boolean; error?: string }> {
  const config = embeddingConfigForProvider(provider);
  if (provider === "local") {
    const generated = await generateLikesEmbeddings(rows, config);
    storeEmbeddings("likes", "local", generated, config, replace, sqlite);
    return { updated: true };
  }

  if (provider !== "ollama" && !config.apiKey) return { updated: false };

  if (!replace && !canExtendRemoteIndex("likes", provider, config, rows, sqlite)) {
    return {
      updated: false,
      error: `${provider} likes index provenance differs or is incomplete`,
    };
  }

  try {
    const generated = await generateLikesEmbeddings(rows, config);
    storeEmbeddings("likes", provider, generated, config, replace, sqlite);
    return { updated: true };
  } catch (error) {
    return {
      updated: false,
      error: error instanceof Error ? error.message : "unknown error",
    };
  }
}

function formatSyncMessage(
  library: SearchLibrary,
  rowsLength: number,
  updatedProviders: string[],
  notes: string[],
  targets: EmbeddingProvider[],
): EmbeddingSyncResult {
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

  const remoteConfigured = configuredRemoteProviders(library);
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
  const sqlite = getSqlite();
  const rows = allSavesSearchRows(sqlite, uniqueIds);
  const updatedProviders: string[] = [];
  const notes: string[] = [];
  const targets = configuredProviders("saves");

  for (const provider of targets) {
    const result = await syncSavesProviderIndex(provider, rows, false, sqlite);
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
  const sqlite = getSqlite();
  const rows = allLikesSearchRows(sqlite, uniqueIds);
  const updatedProviders: string[] = [];
  const notes: string[] = [];
  const targets = configuredProviders("likes");

  for (const provider of targets) {
    const result = await syncLikesProviderIndex(provider, rows, false, sqlite);
    if (result.updated) {
      updatedProviders.push(provider);
    } else if (result.error) {
      notes.push(`${provider}: ${result.error}`);
    }
  }

  return formatSyncMessage("likes", rows.length, updatedProviders, notes, targets);
}

function assertProviderRebuildable(
  provider: EmbeddingProvider,
  library: SearchLibrary,
) {
  if (!isProviderConfigured(provider, library)) {
    throw new Error(
      `${provider} is not enabled for ${library} — turn it on in Settings (and add credentials if needed) before reindexing`,
    );
  }
  if (provider !== "local" && provider !== "ollama") {
    const config = embeddingConfigForProvider(provider);
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

/**
 * Rebuild a single provider's vector index with incremental progress.
 * Embedding network calls never run inside a SQLite write transaction.
 */
export async function rebuildProviderIndex(
  library: SearchLibrary,
  provider: EmbeddingProvider,
  options?: {
    onProgress?: RebuildProgressCallback;
    shouldCancel?: () => boolean;
  },
): Promise<{ items: number }> {
  assertProviderRebuildable(provider, library);

  const sqlite = getSqlite();
  const config = embeddingConfigForProvider(provider);
  const onProgress = options?.onProgress;
  const shouldCancel = options?.shouldCancel;
  const targetLabel = formatJobTarget(library, provider);

  if (library === "saves") {
    const rows = allSavesSearchRows(sqlite);
    const total = rows.length;

    await emitProgress(onProgress, {
      phase: "preparing",
      processed: 0,
      total,
      currentProvider: provider,
      message: `Preparing ${targetLabel} index…`,
    });
    throwIfCancelled(shouldCancel);

    sqlite.transaction(() => {
      recreateVectorTable("saves", provider, config.profile.dimensions, sqlite);
    })();

    let processed = 0;
    for (const row of rows) {
      throwIfCancelled(shouldCancel);
      await emitProgress(onProgress, {
        phase: "embedding",
        processed,
        total,
        currentProvider: provider,
        message: `Embedding ${targetLabel} ${processed + 1}/${total}…`,
      });

      const embedding = await embedText(
        buildSearchDocument(row).combined,
        config,
      );

      throwIfCancelled(shouldCancel);

      sqlite.transaction(() => {
        upsertItemEmbedding("saves", provider, row.id, embedding, sqlite);
      })();

      processed += 1;
      await emitProgress(onProgress, {
        phase: "embedding",
        processed,
        total,
        currentProvider: provider,
        message: `Embedded ${targetLabel} ${processed}/${total}`,
      });
    }

    sqlite.transaction(() => {
      writeEmbeddingProfile("saves", provider, config.profile, sqlite);
    })();

    await emitProgress(onProgress, {
      phase: "done",
      processed,
      total,
      currentProvider: provider,
      message: `${targetLabel} index rebuilt (${processed} items)`,
    });

    return { items: processed };
  }

  const rows = allLikesSearchRows(sqlite);
  const total = rows.length;

  await emitProgress(onProgress, {
    phase: "preparing",
    processed: 0,
    total,
    currentProvider: provider,
    message: `Preparing ${targetLabel} index…`,
  });
  throwIfCancelled(shouldCancel);

  sqlite.transaction(() => {
    recreateVectorTable("likes", provider, config.profile.dimensions, sqlite);
  })();

  let processed = 0;
  for (const row of rows) {
    throwIfCancelled(shouldCancel);
    await emitProgress(onProgress, {
      phase: "embedding",
      processed,
      total,
      currentProvider: provider,
      message: `Embedding ${targetLabel} ${processed + 1}/${total}…`,
    });

    const embedding = await embedText(
      buildLikedSearchDocument(row).combined,
      config,
    );

    throwIfCancelled(shouldCancel);

    sqlite.transaction(() => {
      upsertItemEmbedding("likes", provider, row.id, embedding, sqlite);
    })();

    processed += 1;
    await emitProgress(onProgress, {
      phase: "embedding",
      processed,
      total,
      currentProvider: provider,
      message: `Embedded ${targetLabel} ${processed}/${total}`,
    });
  }

  sqlite.transaction(() => {
    writeEmbeddingProfile("likes", provider, config.profile, sqlite);
  })();

  await emitProgress(onProgress, {
    phase: "done",
    processed,
    total,
    currentProvider: provider,
    message: `${targetLabel} index rebuilt (${processed} items)`,
  });

  return { items: processed };
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
  if (options?.requireRemote && !isRemoteEmbeddingConfigured()) {
    throw new Error(
      "--remote requires at least one enabled neural provider (OpenAI/Voyage with keys, and/or Ollama)",
    );
  }

  const sqlite = getSqlite();
  const savesRows = allSavesSearchRows(sqlite);
  const likesRows = allLikesSearchRows(sqlite);
  const onProgress = options?.onProgress;
  const shouldCancel = options?.shouldCancel;
  const pairs: Array<{ library: SearchLibrary; provider: EmbeddingProvider }> =
    [];
  for (const library of SEARCH_LIBRARIES) {
    for (const provider of configuredProviders(library)) {
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

  sqlite.transaction(() => {
    sqlite.exec(`DELETE FROM saved_items_fts`);
    for (const row of savesRows) upsertItemFts(row.id, row, sqlite);
    sqlite.exec(`DELETE FROM liked_items_fts`);
    for (const row of likesRows) upsertLikedItemFtsDoc(row.id, row, sqlite);
  })();

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

/** Backfill keyword index; local vectors only when the local index is enabled. */
export function ensureSearchIndexBackfill() {
  const sqlite = getSqlite();
  const savesRows = allSavesSearchRows(sqlite);
  const likesRows = allLikesSearchRows(sqlite);

  if (savesRows.length > 0 && ftsCount("saves", sqlite) < savesRows.length) {
    sqlite.transaction(() => {
      for (const row of savesRows) upsertItemFts(row.id, row, sqlite);
    })();
  }

  if (likesRows.length > 0 && ftsCount("likes", sqlite) < likesRows.length) {
    sqlite.transaction(() => {
      for (const row of likesRows) upsertLikedItemFtsDoc(row.id, row, sqlite);
    })();
  }

  const localConfig = localEmbeddingConfig();

  if (
    isProviderConfigured("local", "saves") &&
    savesRows.length > 0 &&
    !(
      vecCount("saves", "local", sqlite) >= savesRows.length &&
      vectorIndexMatchesConfig("saves", "local", localConfig, sqlite)
    )
  ) {
    const generated = savesRows.map((row) => ({
      id: row.id,
      embedding: embedTextLocal(
        buildSearchDocument(row).combined,
        localConfig.profile.dimensions,
      ),
    }));
    storeEmbeddings("saves", "local", generated, localConfig, true, sqlite);
  }

  if (
    isProviderConfigured("local", "likes") &&
    likesRows.length > 0 &&
    !(
      vecCount("likes", "local", sqlite) >= likesRows.length &&
      vectorIndexMatchesConfig("likes", "local", localConfig, sqlite)
    )
  ) {
    const generated = likesRows.map((row) => ({
      id: row.id,
      embedding: embedTextLocal(
        buildLikedSearchDocument(row).combined,
        localConfig.profile.dimensions,
      ),
    }));
    storeEmbeddings("likes", "local", generated, localConfig, true, sqlite);
  }
}
