import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as sqliteVec from "sqlite-vec";
import * as schema from "./schema";

/** The offline feature-hash index is deliberately fixed across providers. */
const VEC_DIMENSIONS = 1024;

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

  // WAL: readers don't block writers; crash-safe append log.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");

  sqliteVec.load(sqlite);

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

  ensureSearchSchema(sqlite);

  return sqlite;
}

function ensureSearchSchema(sqlite: Database.Database) {
  const legacyRemoteProvider = migrateEmbeddingProfilesTable(sqlite);

  const ftsExists = sqlite
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'saved_items_fts'`,
    )
    .get();

  if (!ftsExists) {
    sqlite.exec(`
      CREATE VIRTUAL TABLE saved_items_fts USING fts5(
        author_username,
        shortcode,
        media_key,
        media_type,
        collections,
        tokenize = 'porter unicode61 remove_diacritics 1'
      );
    `);
  }

  ensureVectorTable(sqlite, "local");
  ensureVectorTable(sqlite, "openai");
  ensureVectorTable(sqlite, "voyage");
  migrateLegacyRemoteVectorTable(sqlite, legacyRemoteProvider);
}

/** Returns the legacy remote provider when migrating off `saved_items_vec_remote`. */
function migrateEmbeddingProfilesTable(
  sqlite: Database.Database,
): "openai" | "voyage" | null {
  const table = sqlite
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'table' AND name = 'embedding_index_profiles'`,
    )
    .get() as { sql: string | null } | undefined;

  const needsMigration = table?.sql?.includes("'remote'") ?? false;
  if (!table) {
    sqlite.exec(`
      CREATE TABLE embedding_index_profiles (
        index_name TEXT PRIMARY KEY CHECK (index_name IN ('local', 'openai', 'voyage')),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        endpoint TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    return null;
  }

  if (!needsMigration) return null;

  const legacyRemote = sqlite
    .prepare(
      `SELECT provider, model, dimensions, endpoint, updated_at
       FROM embedding_index_profiles WHERE index_name = 'remote'`,
    )
    .get() as
    | {
        provider: string;
        model: string;
        dimensions: number;
        endpoint: string | null;
        updated_at: number;
      }
    | undefined;

  sqlite.exec(`
    CREATE TABLE embedding_index_profiles_new (
      index_name TEXT PRIMARY KEY CHECK (index_name IN ('local', 'openai', 'voyage')),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      endpoint TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    INSERT INTO embedding_index_profiles_new(
      index_name, provider, model, dimensions, endpoint, updated_at
    )
    SELECT index_name, provider, model, dimensions, endpoint, updated_at
    FROM embedding_index_profiles
    WHERE index_name IN ('local', 'openai', 'voyage');
  `);

  let migratedProvider: "openai" | "voyage" | null = null;
  if (
    legacyRemote &&
    (legacyRemote.provider === "openai" || legacyRemote.provider === "voyage")
  ) {
    migratedProvider = legacyRemote.provider;
    sqlite
      .prepare(
        `INSERT OR REPLACE INTO embedding_index_profiles_new(
          index_name, provider, model, dimensions, endpoint, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        legacyRemote.provider,
        legacyRemote.provider,
        legacyRemote.model,
        legacyRemote.dimensions,
        legacyRemote.endpoint,
        legacyRemote.updated_at,
      );
  }

  sqlite.exec(`
    DROP TABLE embedding_index_profiles;
    ALTER TABLE embedding_index_profiles_new RENAME TO embedding_index_profiles;
  `);
  return migratedProvider;
}

function ensureVectorTable(
  sqlite: Database.Database,
  index: "local" | "openai" | "voyage",
) {
  const table = `saved_items_vec_${index}`;
  const definition = sqlite
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'table' AND name = ?`,
    )
    .get(table) as { sql: string | null } | undefined;

  const dimensions = Number(
    definition?.sql?.match(/embedding\s+FLOAT\[(\d+)\]/i)?.[1],
  );
  if (!definition || dimensions !== VEC_DIMENSIONS) {
    sqlite.exec(`
      DROP TABLE IF EXISTS ${table};
      CREATE VIRTUAL TABLE ${table} USING vec0(
        item_id INTEGER PRIMARY KEY,
        embedding FLOAT[${VEC_DIMENSIONS}]
      );
      DELETE FROM embedding_index_profiles WHERE index_name = '${index}';
    `);
  }
}

function migrateLegacyRemoteVectorTable(
  sqlite: Database.Database,
  target: "openai" | "voyage" | null,
) {
  const remoteExists = sqlite
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master
       WHERE type = 'table' AND name = 'saved_items_vec_remote'`,
    )
    .get();

  if (!remoteExists) return;

  if (target) {
    const targetTable = `saved_items_vec_${target}`;
    const targetCount = (
      sqlite
        .prepare(`SELECT count(*) AS c FROM ${targetTable}`)
        .get() as { c: number }
    ).c;
    if (targetCount === 0) {
      sqlite.exec(`
        INSERT INTO ${targetTable}(item_id, embedding)
        SELECT item_id, embedding FROM saved_items_vec_remote;
      `);
    }
  }

  sqlite.exec(`DROP TABLE IF EXISTS saved_items_vec_remote;`);
}

const globalForDb = globalThis as unknown as {
  sqlite?: Database.Database;
  db?: ReturnType<typeof drizzle<typeof schema>>;
};

export function getSqlite() {
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
