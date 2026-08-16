/**
 * FTS5 upsert / remove / count helpers for saves + likes search docs.
 * Extracted from sync.ts; embedding sync orchestration stays there.
 */
import type Database from "better-sqlite3";
import { getSqlite } from "../db";
import {
  buildLikedSearchDocument,
  buildSearchDocument,
  type LikedSearchableItem,
  type SearchableItem,
} from "./document";
import {
  ALL_VECTOR_INDEXES,
  type SearchLibrary,
  vectorTableName,
} from "./library";
import { vectorTableDimensions } from "./sync-vec-store";

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
