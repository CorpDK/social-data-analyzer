import type Database from "better-sqlite3";
import { getSqlite } from "../db";
import {
  buildLikedSearchDocument,
  buildSearchDocument,
  type LikedSearchableItem,
  type SearchableItem,
} from "./document";
import {
  embedTextLocal,
  embedTexts,
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
  assessReindexMemory,
  estimatedVectorMegabytes,
  logReindexMemoryWarning,
} from "./memory";
import {
  configuredProviders,
  configuredRemoteProviders,
  isProviderConfigured,
} from "./providers";

export type { VectorIndexName, SearchLibrary } from "./library";

/** Rows embedded + written per chunk (keeps peak vector RAM bounded). */
export const EMBEDDING_SYNC_CHUNK_SIZE = 128;

/**
 * Max bind params per `IN (...)` clause. SQLite's default
 * SQLITE_MAX_VARIABLE_NUMBER is often 32766 (sometimes 999); staying well
 * under avoids silent "too many SQL variables" failures on large imports.
 */
export const SQL_IN_CLAUSE_BATCH_SIZE = 500;

async function yieldToEventLoop() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Split ids into batches safe for a single SQLite `IN (...)` clause. */
export function chunkIdsForSqlIn(
  ids: number[],
  batchSize: number = SQL_IN_CLAUSE_BATCH_SIZE,
): number[][] {
  if (ids.length === 0) return [];
  const size = Math.max(1, Math.floor(batchSize));
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

/** Progress ticks from rebuild loops: every N items or ~1 Hz. */
const REBUILD_PROGRESS_EVERY_N = 50;
const REBUILD_PROGRESS_MIN_MS = 1_000;

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

type GeneratedEmbedding = { id: number; embedding: Float32Array };

export type EmbeddingSyncResult = {
  status: "updated" | "skipped";
  items: number;
  providers: string[];
  message: string;
};

function mapSavesSearchRow(row: unknown): SavesSearchRow {
  const typed = row as Omit<SavesSearchRow, "collections"> & {
    collections: string;
  };
  return {
    ...typed,
    collections: typed.collections
      ? typed.collections.split("\u001f").filter(Boolean)
      : [],
  };
}

function querySavesSearchRowsBatch(
  sqlite: Database.Database,
  itemIds?: number[],
): SavesSearchRow[] {
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
    .map(mapSavesSearchRow);
}

/**
 * Load saves rows for embedding. When `itemIds` is provided, queries are
 * chunked so large imports never hit SQLite's bind-variable limit.
 * Exported for tests (synthetic >32k id sets).
 */
export function allSavesSearchRows(
  sqlite: Database.Database = getSqlite(),
  itemIds?: number[],
): SavesSearchRow[] {
  if (itemIds?.length === 0) return [];
  if (!itemIds) return querySavesSearchRowsBatch(sqlite);
  const out: SavesSearchRow[] = [];
  for (const batch of chunkIdsForSqlIn(itemIds)) {
    out.push(...querySavesSearchRowsBatch(sqlite, batch));
  }
  return out;
}

function queryLikesSearchRowsBatch(
  sqlite: Database.Database,
  itemIds?: number[],
): LikesSearchRow[] {
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

/**
 * Load likes rows for embedding. Chunks `IN (...)` when filtering by ids.
 * Exported for tests (synthetic >32k id sets).
 */
export function allLikesSearchRows(
  sqlite: Database.Database = getSqlite(),
  itemIds?: number[],
): LikesSearchRow[] {
  if (itemIds?.length === 0) return [];
  if (!itemIds) return queryLikesSearchRowsBatch(sqlite);
  const out: LikesSearchRow[] = [];
  for (const batch of chunkIdsForSqlIn(itemIds)) {
    out.push(...queryLikesSearchRowsBatch(sqlite, batch));
  }
  return out;
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

/** Insert into an empty / freshly recreated vec table (no prior DELETE). */
export function insertItemEmbedding(
  library: SearchLibrary,
  index: VectorIndexName,
  itemId: number,
  embedding: Float32Array,
  sqlite: Database.Database = getSqlite(),
) {
  sqlite
    .prepare(
      `INSERT INTO ${vectorTableName(library, index)}(item_id, embedding) VALUES (?, ?)`,
    )
    .run(BigInt(itemId), embeddingToBuffer(embedding));
}

/** True single-item upsert (DELETE + INSERT). Prefer chunk inserts on rebuild. */
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

function chunkRows<T>(rows: T[], size = EMBEDDING_SYNC_CHUNK_SIZE): T[][] {
  if (rows.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

function existingEmbeddingItemIds(
  library: SearchLibrary,
  index: VectorIndexName,
  sqlite: Database.Database,
): Set<number> {
  if (vectorTableDimensions(library, index, sqlite) === null) return new Set();
  const rows = sqlite
    .prepare(
      `SELECT item_id AS id FROM ${vectorTableName(library, index)}`,
    )
    .all() as Array<{ id: number | bigint }>;
  return new Set(rows.map((row) => Number(row.id)));
}

/**
 * Resume-friendly rebuilds keep an existing vec table when dimensions match
 * and any stored profile still agrees with Settings. A missing profile is OK
 * (first build crashed before the end-of-job profile write).
 */
function canResumeVectorRebuild(
  library: SearchLibrary,
  index: VectorIndexName,
  config: EmbeddingConfig,
  sqlite: Database.Database,
): boolean {
  if (
    vectorTableDimensions(library, index, sqlite) !==
    config.profile.dimensions
  ) {
    return false;
  }
  if (vecCount(library, index, sqlite) <= 0) return false;
  const indexed = getIndexedEmbeddingProfile(library, index, sqlite);
  if (indexed && !embeddingProfilesMatch(indexed, config.profile)) {
    return false;
  }
  return true;
}

async function generateSavesEmbeddingsChunk(
  rows: SavesSearchRow[],
  config: EmbeddingConfig,
): Promise<GeneratedEmbedding[]> {
  if (rows.length === 0) return [];
  const texts = rows.map((row) => buildSearchDocument(row).combined);
  const embeddings = await embedTexts(texts, config);
  return rows.map((row, i) => ({
    id: row.id,
    embedding: embeddings[i]!,
  }));
}

async function generateLikesEmbeddingsChunk(
  rows: LikesSearchRow[],
  config: EmbeddingConfig,
): Promise<GeneratedEmbedding[]> {
  if (rows.length === 0) return [];
  const texts = rows.map((row) => buildLikedSearchDocument(row).combined);
  const embeddings = await embedTexts(texts, config);
  return rows.map((row, i) => ({
    id: row.id,
    embedding: embeddings[i]!,
  }));
}

/**
 * How chunk rows are written. `insert-only` is the fast path and is valid *only*
 * for a table we just recreated in this call; anything that keeps existing rows
 * must use `upsert` so a re-run cannot hit a primary-key conflict.
 */
export type EmbeddingWriteMode = "insert-only" | "upsert";

function prepareVectorTableForStore(
  library: SearchLibrary,
  index: VectorIndexName,
  config: EmbeddingConfig,
  replace: boolean,
  sqlite: Database.Database,
): { writeMode: EmbeddingWriteMode } {
  const needsRecreate =
    replace ||
    vectorTableDimensions(library, index, sqlite) !==
      config.profile.dimensions;
  if (needsRecreate) {
    recreateVectorTable(library, index, config.profile.dimensions, sqlite);
    // Write profile immediately so a mid-rebuild crash can resume with a
    // matching provenance check (final write at end still refreshes updated_at).
    writeEmbeddingProfile(library, index, config.profile, sqlite);
    return { writeMode: "insert-only" };
  }
  // Extending an existing table: upsert (DELETE + INSERT) per row.
  return { writeMode: "upsert" };
}

/**
 * Write one chunk of embeddings in a single transaction.
 * Exported for tests: `upsert` must stay idempotent for the resume path.
 */
export function writeEmbeddingChunk(
  library: SearchLibrary,
  index: VectorIndexName,
  generated: GeneratedEmbedding[],
  writeMode: EmbeddingWriteMode,
  sqlite: Database.Database = getSqlite(),
) {
  if (generated.length === 0) return;
  sqlite.transaction(() => {
    for (const result of generated) {
      if (writeMode === "upsert") {
        upsertItemEmbedding(library, index, result.id, result.embedding, sqlite);
      } else {
        insertItemEmbedding(library, index, result.id, result.embedding, sqlite);
      }
    }
  })();
}

/**
 * Stream embeddings in chunks: embed → write → drop references.
 * Never materializes the full library's Float32Arrays at once.
 *
 * When `resume` is true and the existing vec table matches the config profile,
 * already-embedded item_ids are skipped (crash/restart safe). Otherwise the
 * table is recreated (fresh rebuild).
 */
async function storeEmbeddingsChunked(
  library: SearchLibrary,
  index: VectorIndexName,
  rows: SavesSearchRow[] | LikesSearchRow[],
  config: EmbeddingConfig,
  replace: boolean,
  sqlite: Database.Database,
  options?: {
    resume?: boolean;
    onChunk?: (processed: number, total: number) => void | Promise<void>;
    shouldCancel?: () => boolean;
  },
) {
  const total = rows.length;
  const wantResume = Boolean(options?.resume) && !replace;
  // The caller's resume hint (job.processed > 0) is never trusted on its own:
  // the vec table itself decides whether a resume is possible.
  const resumeOk =
    wantResume && canResumeVectorRebuild(library, index, config, sqlite);

  let workRows = rows;
  let alreadyDone = 0;
  let writeMode: EmbeddingWriteMode;

  if (resumeOk) {
    const existing = existingEmbeddingItemIds(library, index, sqlite);
    // Count only ids we would otherwise embed, so progress can't exceed total
    // when the table holds vectors for since-deleted items.
    alreadyDone = (rows as Array<{ id: number }>).filter((row) =>
      existing.has(row.id),
    ).length;
    workRows = (rows as Array<{ id: number }>).filter(
      (row) => !existing.has(row.id),
    ) as typeof rows;
    // Resume keeps existing rows, so writes must be idempotent: the skip set is
    // a snapshot, and a re-run (or a leftover row from an interrupted chunk)
    // would otherwise fail the whole job on a primary-key conflict.
    writeMode = "upsert";
  } else {
    writeMode = prepareVectorTableForStore(
      library,
      index,
      config,
      replace || wantResume,
      sqlite,
    ).writeMode;
  }

  let processed = alreadyDone;
  await options?.onChunk?.(processed, total);

  if (library === "saves") {
    const savesRows = workRows as SavesSearchRow[];
    for (const chunk of chunkRows(savesRows)) {
      throwIfCancelled(options?.shouldCancel);
      const generated = await generateSavesEmbeddingsChunk(chunk, config);
      throwIfCancelled(options?.shouldCancel);
      writeEmbeddingChunk(library, index, generated, writeMode, sqlite);
      processed += chunk.length;
      await options?.onChunk?.(processed, total);
      await yieldToEventLoop();
    }
  } else {
    const likesRows = workRows as LikesSearchRow[];
    for (const chunk of chunkRows(likesRows)) {
      throwIfCancelled(options?.shouldCancel);
      const generated = await generateLikesEmbeddingsChunk(chunk, config);
      throwIfCancelled(options?.shouldCancel);
      writeEmbeddingChunk(library, index, generated, writeMode, sqlite);
      processed += chunk.length;
      await options?.onChunk?.(processed, total);
      await yieldToEventLoop();
    }
  }

  writeEmbeddingProfile(library, index, config.profile, sqlite);
}

/** Local-only chunked backfill (sync, no network). */
function storeLocalEmbeddingsChunked(
  library: SearchLibrary,
  rows: SavesSearchRow[] | LikesSearchRow[],
  config: EmbeddingConfig,
  sqlite: Database.Database,
) {
  // replace=true always recreates the table, so insert-only is safe here.
  const { writeMode } = prepareVectorTableForStore(
    library,
    "local",
    config,
    true,
    sqlite,
  );
  if (library === "saves") {
    for (const chunk of chunkRows(rows as SavesSearchRow[])) {
      const generated: GeneratedEmbedding[] = chunk.map((row) => ({
        id: row.id,
        embedding: embedTextLocal(
          buildSearchDocument(row).combined,
          config.profile.dimensions,
        ),
      }));
      writeEmbeddingChunk(library, "local", generated, writeMode, sqlite);
    }
  } else {
    for (const chunk of chunkRows(rows as LikesSearchRow[])) {
      const generated: GeneratedEmbedding[] = chunk.map((row) => ({
        id: row.id,
        embedding: embedTextLocal(
          buildLikedSearchDocument(row).combined,
          config.profile.dimensions,
        ),
      }));
      writeEmbeddingChunk(library, "local", generated, writeMode, sqlite);
    }
  }
  writeEmbeddingProfile(library, "local", config.profile, sqlite);
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
    await storeEmbeddingsChunked("saves", "local", rows, config, replace, sqlite);
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
    await storeEmbeddingsChunked("saves", provider, rows, config, replace, sqlite);
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
    await storeEmbeddingsChunked("likes", "local", rows, config, replace, sqlite);
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
    await storeEmbeddingsChunked("likes", provider, rows, config, replace, sqlite);
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

function createRebuildProgressEmitter(
  onProgress: RebuildProgressCallback | undefined,
): RebuildProgressCallback {
  let lastEmitAt = 0;
  let lastProcessed = -1;
  return async (progress) => {
    const now = Date.now();
    const force =
      progress.phase === "done" ||
      progress.phase === "preparing" ||
      progress.phase === "fts" ||
      progress.processed === 0 ||
      (progress.total > 0 && progress.processed >= progress.total) ||
      progress.processed - lastProcessed >= REBUILD_PROGRESS_EVERY_N ||
      now - lastEmitAt >= REBUILD_PROGRESS_MIN_MS;
    if (!force) return;
    lastEmitAt = now;
    lastProcessed = progress.processed;
    await emitProgress(onProgress, progress);
  };
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
  assertProviderRebuildable(provider, library);

  const sqlite = getSqlite();
  const config = embeddingConfigForProvider(provider);
  const emit = createRebuildProgressEmitter(options?.onProgress);
  const shouldCancel = options?.shouldCancel;
  const targetLabel = formatJobTarget(library, provider);
  const rows =
    library === "saves" ? allSavesSearchRows(sqlite) : allLikesSearchRows(sqlite);
  const total = rows.length;
  const resumeRequested = Boolean(options?.resume);
  const resume =
    resumeRequested && canResumeVectorRebuild(library, provider, config, sqlite);

  logReindexMemoryWarning(assessReindexMemory(library, provider, total));

  let already = 0;
  if (resume) {
    const existing = existingEmbeddingItemIds(library, provider, sqlite);
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
    sqlite,
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
    storeLocalEmbeddingsChunked("saves", savesRows, localConfig, sqlite);
  }

  if (
    isProviderConfigured("local", "likes") &&
    likesRows.length > 0 &&
    !(
      vecCount("likes", "local", sqlite) >= likesRows.length &&
      vectorIndexMatchesConfig("likes", "local", localConfig, sqlite)
    )
  ) {
    if (likesRows.length >= 20_000) {
      console.warn(
        `[search] Local likes backfill for ${likesRows.length} items ` +
          `(~${estimatedVectorMegabytes(likesRows.length).toFixed(0)} MB vectors) streaming in chunks of ${EMBEDDING_SYNC_CHUNK_SIZE}.`,
      );
    }
    storeLocalEmbeddingsChunked("likes", likesRows, localConfig, sqlite);
  }
}
