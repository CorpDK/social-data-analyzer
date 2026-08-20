/**
 * Chunked embedding generate/store path (resume-safe).
 * Extracted from sync.ts; rebuild / incremental sync orchestration stays there.
 */
import type { SearchIndex } from "../storage";
import {
  buildLikedSearchDocument,
  buildSearchDocument,
} from "./document";
import {
  embedTextLocal,
  embedTexts,
  type EmbeddingConfig,
} from "./embeddings";
import { type SearchLibrary, type VectorIndexName } from "./library";
import {
  embeddingProfilesMatch,
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

export async function existingEmbeddingItemIds(
  library: SearchLibrary,
  index: VectorIndexName,
  search: SearchIndex,
): Promise<Set<number>> {
  return search.existingEmbeddingItemIds(library, index);
}

/**
 * Resume-friendly rebuilds keep an existing vec table when dimensions match
 * and any stored profile still agrees with Settings. A missing profile is OK
 * (first build crashed before the end-of-job profile write).
 */
export async function canResumeVectorRebuild(
  library: SearchLibrary,
  index: VectorIndexName,
  config: EmbeddingConfig,
  search: SearchIndex,
): Promise<boolean> {
  if (
    (await search.vectorTableDimensions(library, index)) !==
    config.profile.dimensions
  ) {
    return false;
  }
  if ((await search.vecCount(library, index)) <= 0) return false;
  const indexed = await search.getIndexedEmbeddingProfile(library, index);
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

async function prepareVectorTableForStore(
  library: SearchLibrary,
  index: VectorIndexName,
  config: EmbeddingConfig,
  replace: boolean,
  search: SearchIndex,
): Promise<{ writeMode: EmbeddingWriteMode }> {
  const needsRecreate =
    replace ||
    (await search.vectorTableDimensions(library, index)) !==
      config.profile.dimensions;
  if (needsRecreate) {
    await search.recreateVectorTable(library, index, config.profile.dimensions);
    // Write profile immediately so a mid-rebuild crash can resume with a
    // matching provenance check (final write at end still refreshes updated_at).
    await search.writeEmbeddingProfile(library, index, config.profile);
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
  search: SearchIndex,
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
    wantResume && (await canResumeVectorRebuild(library, index, config, search));

  let workRows = rows;
  let alreadyDone = 0;
  let writeMode: EmbeddingWriteMode;

  if (resumeOk) {
    const existing = await existingEmbeddingItemIds(library, index, search);
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
    writeMode = (await prepareVectorTableForStore(
      library,
      index,
      config,
      replace || wantResume,
      search,
    )).writeMode;
  }

  let processed = alreadyDone;
  await options?.onChunk?.(processed, total);

  if (library === "saves") {
    const savesRows = workRows as SavesSearchRow[];
    for (const chunk of chunkRows(savesRows)) {
      throwIfCancelled(options?.shouldCancel);
      const generated = await generateSavesEmbeddingsChunk(chunk, config);
      throwIfCancelled(options?.shouldCancel);
      await search.writeEmbeddingChunk(library, index, generated, writeMode);
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
      await search.writeEmbeddingChunk(library, index, generated, writeMode);
      processed += chunk.length;
      await options?.onChunk?.(processed, total);
      await yieldToEventLoop();
    }
  }

  await search.writeEmbeddingProfile(library, index, config.profile);
}

/** Local-only chunked backfill (sync, no network). */
export async function storeLocalEmbeddingsChunked(
  library: SearchLibrary,
  rows: SavesSearchRow[] | LikesSearchRow[],
  config: EmbeddingConfig,
  search: SearchIndex,
) {
  // replace=true always recreates the table, so insert-only is safe here.
  const { writeMode } = await prepareVectorTableForStore(
    library,
    "local",
    config,
    true,
    search,
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
      await search.writeEmbeddingChunk(library, "local", generated, writeMode);
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
      await search.writeEmbeddingChunk(library, "local", generated, writeMode);
    }
  }
  await search.writeEmbeddingProfile(library, "local", config.profile);
}

