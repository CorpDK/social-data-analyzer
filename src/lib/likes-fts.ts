import type Database from "better-sqlite3";
import { getSqlite } from "./db";
import type { LikedMediaType, LikedSource } from "./parse-export";

export type LikedSearchableItem = {
  authorUsername: string | null;
  shortcode: string | null;
  mediaKey: string;
  mediaType: LikedMediaType | string;
  source: LikedSource | string;
};

export function upsertLikedItemFts(
  itemId: number,
  item: LikedSearchableItem,
  sqlite: Database.Database = getSqlite(),
) {
  sqlite.prepare(`DELETE FROM liked_items_fts WHERE rowid = ?`).run(itemId);
  sqlite
    .prepare(
      `INSERT INTO liked_items_fts(
        rowid, author_username, shortcode, media_key, media_type, source
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      itemId,
      item.authorUsername ?? "",
      item.shortcode ?? "",
      item.mediaKey,
      item.mediaType,
      item.source,
    );
}

export function searchLikedItemIds(
  query: string,
  limit = 500,
  sqlite: Database.Database = getSqlite(),
): number[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // Escape FTS5 special chars loosely by quoting the phrase.
  const safe = `"${trimmed.replace(/"/g, '""')}"`;

  try {
    const rows = sqlite
      .prepare(
        `SELECT rowid AS id
         FROM liked_items_fts
         WHERE liked_items_fts MATCH ?
         LIMIT ?`,
      )
      .all(safe, limit) as Array<{ id: number }>;
    return rows.map((row) => row.id);
  } catch {
    return [];
  }
}
