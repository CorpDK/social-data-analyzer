import type Database from "better-sqlite3";
import { buildFtsQuery } from "../../search/hybrid";
import type { SearchLibrary } from "../../search/library";

export function searchSqliteFts(
  sqlite: Database.Database,
  library: SearchLibrary,
  query: string,
  limit: number,
): { hits: Array<{ id: number; rank: number }>; degraded: boolean } {
  const match = buildFtsQuery(query);
  if (!match) return { hits: [], degraded: false };
  const table = library === "saves" ? "saved_items_fts" : "liked_items_fts";
  try {
    const hits = sqlite
      .prepare(
        `SELECT rowid AS id, rank
         FROM ${table}
         WHERE ${table} MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(match, limit) as Array<{ id: number; rank: number }>;
    return { hits, degraded: false };
  } catch {
    return { hits: [], degraded: true };
  }
}
