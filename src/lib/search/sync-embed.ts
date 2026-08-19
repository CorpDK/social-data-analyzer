/**
 * Chunked embedding generate/store path (resume-safe).
 * Extracted from sync.ts; rebuild / incremental sync orchestration stays there.
 */
import type Database from "better-sqlite3";
import {
  buildLikedSearchDocument,
  buildSearchDocument,
} from "./document";
import {
  embedTextLocal,
  embedTexts,
  type EmbeddingConfig,
} from "./embeddings";
import {
  type SearchLibrary,
  type VectorIndexName,
  vectorTableName,
} from "./library";
import {
  embeddingProfilesMatch,
  getIndexedEmbeddingProfile,
  recreateVectorTable,
  vecCount,
  vectorTableDimensions,
  writeEmbeddingChunk,
  writeEmbeddingProfile,
  type EmbeddingWriteMode,
} from "./sync-vec-store";
import type { LikesSearchRow, SavesSearchRow } from "./sync-rows";

/** Rows embedded + written per chunk (keeps peak vector RAM bounded). */
export const EMBEDDING_SYNC_CHUNK_SIZE = 128;

async function yieldToEventLoop() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}


export class RebuildCancelledError extends Error {
  constructor(message = "Reindex cancelled") {
    super(message);
    this.name = "RebuildCancelledError";
  }
}

function throwIfCancelled(shouldCancel?: () => boolean) {
  if (shouldCancel?.()) throw new RebuildCancelledError();
}

type GeneratedEmbedding = { id: number; embedding: Float32Array };

function chunkRows<T>(rows: T[], size = EMBEDDING_SYNC_CHUNK_SIZE): T[][] {
  if (rows.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

export function existingEmbeddingItemIds(
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
export function canResumeVectorRebuild(
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
 * Stream embeddings in chunks: embed → write → drop references.
 * Never materializes the full library's Float32Arrays at once.
 *
 * When `resume` is true and the existing vec table matches the config profile,
 * already-embedded item_ids are skipped (crash/restart safe). Otherwise the
 * table is recreated (fresh rebuild).
 */
export async function storeEmbeddingsChunked(
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
export function storeLocalEmbeddingsChunked(
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

