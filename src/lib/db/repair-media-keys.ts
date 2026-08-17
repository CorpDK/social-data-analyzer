/**
 * One-time SCHEMA_VERSION repair: recompute media_key from href so shortcodes
 * keep Instagram case. Never deletes or merges rows on collision.
 */
import type Database from "better-sqlite3";
import { mediaKeyFromHref } from "../parse/types";

type MediaKeyRow = {
  id: number;
  href: string;
  media_key: string;
  shortcode: string | null;
  source?: string | null;
  media_type?: string | null;
  author_username?: string | null;
};

function isCommentRow(row: MediaKeyRow): boolean {
  return (
    row.source === "liked_comments" ||
    row.media_type === "comment" ||
    row.media_key.startsWith("comment:")
  );
}

/**
 * For legacy `comment:<base>:<rest>` keys, restore shortcode case in `<base>`
 * when it matches the href shortcode case-insensitively. Stronger fbid/id keys
 * and already case-correct keys are left alone.
 */
function repairedCommentMediaKey(row: MediaKeyRow): string | null {
  if (row.media_key.startsWith("comment:fbid:")) return null;
  if (row.media_key.startsWith("comment:id:")) return null;

  const base = mediaKeyFromHref(row.href);
  if (!base) return null;

  const match = /^comment:([^:]+)(:.*)?$/.exec(row.media_key);
  if (!match?.[1]) return null;
  const oldBase = match[1];
  if (oldBase.toLowerCase() !== base.toLowerCase()) return null;
  if (oldBase === base) return null;

  const rest = match[2] ?? "";
  return `comment:${base}${rest}`;
}

function repairedPlainMediaKey(row: MediaKeyRow): string | null {
  const next = mediaKeyFromHref(row.href);
  if (!next || next === row.media_key) return null;
  // Only rewrite when the change is case (or host) normalization of the same
  // identity — never invent a key that does not derive from href.
  return next;
}

function tableHasColumn(
  sqlite: Database.Database,
  table: string,
  column: string,
): boolean {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return cols.some((c) => c.name === column);
}

function occupiedKeys(
  sqlite: Database.Database,
  table: "saved_items" | "liked_items",
): Set<string> {
  const rows = sqlite
    .prepare(`SELECT media_key AS mediaKey FROM ${table}`)
    .all() as Array<{ mediaKey: string }>;
  return new Set(rows.map((r) => r.mediaKey));
}

function refreshFtsMediaKey(
  sqlite: Database.Database,
  ftsTable: "saved_items_fts" | "liked_items_fts",
  rowid: number,
  mediaKey: string,
  shortcode: string | null,
) {
  const exists = sqlite
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(ftsTable) as { ok: number } | undefined;
  if (!exists) return;

  // FTS5 content tables: delete + reinsert is the safe update path.
  const current = sqlite
    .prepare(`SELECT * FROM ${ftsTable} WHERE rowid = ?`)
    .get(rowid) as Record<string, unknown> | undefined;
  if (!current) return;

  sqlite.prepare(`DELETE FROM ${ftsTable} WHERE rowid = ?`).run(rowid);

  if (ftsTable === "saved_items_fts") {
    sqlite
      .prepare(
        `INSERT INTO saved_items_fts(
          rowid, author_username, shortcode, media_key, media_type, collections
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rowid,
        current.author_username ?? "",
        shortcode ?? current.shortcode ?? "",
        mediaKey,
        current.media_type ?? "",
        current.collections ?? "",
      );
    return;
  }

  sqlite
    .prepare(
      `INSERT INTO liked_items_fts(
        rowid, author_username, shortcode, media_key, media_type, source
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rowid,
      current.author_username ?? "",
      shortcode ?? current.shortcode ?? "",
      mediaKey,
      current.media_type ?? "",
      current.source ?? "",
    );
}

function applyRepairs(
  sqlite: Database.Database,
  table: "saved_items" | "liked_items",
  ftsTable: "saved_items_fts" | "liked_items_fts",
  rows: MediaKeyRow[],
  nextKeyFor: (row: MediaKeyRow) => string | null,
) {
  const keys = occupiedKeys(sqlite, table);
  const update = sqlite.prepare(
    `UPDATE ${table} SET media_key = ?, updated_at = unixepoch() WHERE id = ?`,
  );

  for (const row of rows) {
    const next = nextKeyFor(row);
    if (!next || next === row.media_key) continue;
    if (keys.has(next)) {
      // Collision: keep both rows; operator can re-import the missing variant.
      continue;
    }
    update.run(next, row.id);
    keys.delete(row.media_key);
    keys.add(next);
    refreshFtsMediaKey(sqlite, ftsTable, row.id, next, row.shortcode);
  }
}

/**
 * Idempotent when `user_version` already >= target; caller gates on version.
 * Safe: never deletes rows; skips updates that would violate UNIQUE(media_key).
 */
export function repairCaseSensitiveMediaKeys(sqlite: Database.Database) {
  if (!tableHasColumn(sqlite, "saved_items", "media_key")) return;

  const savedRows = sqlite
    .prepare(
      `SELECT id, href, media_key, shortcode FROM saved_items`,
    )
    .all() as MediaKeyRow[];
  applyRepairs(
    sqlite,
    "saved_items",
    "saved_items_fts",
    savedRows,
    repairedPlainMediaKey,
  );

  if (!tableHasColumn(sqlite, "liked_items", "media_key")) return;

  const likedRows = sqlite
    .prepare(
      `SELECT id, href, media_key, shortcode, source, media_type, author_username
       FROM liked_items`,
    )
    .all() as MediaKeyRow[];

  applyRepairs(
    sqlite,
    "liked_items",
    "liked_items_fts",
    likedRows,
    (row) =>
      isCommentRow(row)
        ? repairedCommentMediaKey(row)
        : repairedPlainMediaKey(row),
  );
}
