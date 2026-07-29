import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

const dataDir = path.join(process.cwd(), "data");
const dbPath =
  process.env.INSTAGRAM_SAVES_DB ??
  path.join(dataDir, "instagram-saves.db");

function ensureDatabase() {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      imported_at INTEGER NOT NULL DEFAULT (unixepoch()),
      items_found INTEGER NOT NULL DEFAULT 0,
      items_added INTEGER NOT NULL DEFAULT 0,
      items_updated INTEGER NOT NULL DEFAULT 0,
      items_skipped INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'completed',
      error TEXT,
      notes TEXT
    );

    CREATE INDEX IF NOT EXISTS imports_content_hash_idx
      ON imports (content_hash);

    CREATE TABLE IF NOT EXISTS saved_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_key TEXT NOT NULL,
      href TEXT NOT NULL,
      shortcode TEXT,
      media_type TEXT NOT NULL DEFAULT 'unknown',
      author_username TEXT,
      saved_at INTEGER,
      first_seen_import_id INTEGER NOT NULL REFERENCES imports(id),
      last_seen_import_id INTEGER NOT NULL REFERENCES imports(id),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE UNIQUE INDEX IF NOT EXISTS saved_items_media_key_uidx
      ON saved_items (media_key);
    CREATE INDEX IF NOT EXISTS saved_items_author_idx
      ON saved_items (author_username);
    CREATE INDEX IF NOT EXISTS saved_items_type_idx
      ON saved_items (media_type);
    CREATE INDEX IF NOT EXISTS saved_items_saved_at_idx
      ON saved_items (saved_at);

    CREATE TABLE IF NOT EXISTS item_collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES saved_items(id) ON DELETE CASCADE,
      collection_name TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS item_collections_uidx
      ON item_collections (item_id, collection_name);
    CREATE INDEX IF NOT EXISTS item_collections_name_idx
      ON item_collections (collection_name);
  `);

  return sqlite;
}

const globalForDb = globalThis as unknown as {
  sqlite?: Database.Database;
  db?: ReturnType<typeof drizzle<typeof schema>>;
};

function getSqlite() {
  if (!globalForDb.sqlite) {
    globalForDb.sqlite = ensureDatabase();
  }
  return globalForDb.sqlite;
}

export function getDb() {
  if (!globalForDb.db) {
    globalForDb.db = drizzle(getSqlite(), { schema });
  }
  return globalForDb.db;
}

export { schema };
