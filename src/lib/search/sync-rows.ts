/**
 * Row-load helpers for embedding sync (chunked IN() lookups).
 * Extracted from sync.ts — behavior-preserving move.
 */
import type Database from "better-sqlite3";
import type { LikedSearchableItem, SearchableItem } from "./document";

/**
 * Max bind params per `IN (...)` clause. SQLite's default
 * SQLITE_MAX_VARIABLE_NUMBER is often 32766 (sometimes 999); staying well
 * under avoids silent "too many SQL variables" failures on large imports.
 */
export const SQL_IN_CLAUSE_BATCH_SIZE = 500;

export type SavesSearchRow = SearchableItem & { id: number };
export type LikesSearchRow = LikedSearchableItem & { id: number };

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
  sqlite: Database.Database,
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
  sqlite: Database.Database,
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
