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

/**
 * Bump whenever the idempotent schema below gains or changes a table/index.
 * Development re-applies it once per module evaluation for hot-reload safety.
 */
export const SCHEMA_VERSION = 6;

const globalForDb = globalThis as unknown as {
  sqlite?: Database.Database;
  db?: ReturnType<typeof drizzle<typeof schema>>;
  schemaVersion?: number;
};

function createDatabaseConnection() {
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

  return sqlite;
}

function ensureDatabaseSchema(sqlite: Database.Database) {
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

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS import_schemas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      byte_size INTEGER NOT NULL DEFAULT 0,
      truncated_read INTEGER NOT NULL DEFAULT 0,
      top_level_type TEXT NOT NULL DEFAULT 'unknown',
      schema_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE UNIQUE INDEX IF NOT EXISTS import_schemas_import_path_uidx
      ON import_schemas (import_id, file_path);
    CREATE INDEX IF NOT EXISTS import_schemas_import_id_idx
      ON import_schemas (import_id);
    CREATE INDEX IF NOT EXISTS import_schemas_file_path_idx
      ON import_schemas (file_path);

    CREATE TABLE IF NOT EXISTS liked_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_key TEXT NOT NULL,
      href TEXT NOT NULL,
      shortcode TEXT,
      media_type TEXT NOT NULL DEFAULT 'unknown',
      author_username TEXT,
      liked_at INTEGER,
      source TEXT NOT NULL DEFAULT 'liked_posts',
      first_seen_import_id INTEGER NOT NULL REFERENCES imports(id),
      last_seen_import_id INTEGER NOT NULL REFERENCES imports(id),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE UNIQUE INDEX IF NOT EXISTS liked_items_media_key_uidx
      ON liked_items (media_key);
    CREATE INDEX IF NOT EXISTS liked_items_author_idx
      ON liked_items (author_username);
    CREATE INDEX IF NOT EXISTS liked_items_type_idx
      ON liked_items (media_type);
    CREATE INDEX IF NOT EXISTS liked_items_liked_at_idx
      ON liked_items (liked_at);
    CREATE INDEX IF NOT EXISTS liked_items_source_idx
      ON liked_items (source);
  `);

  ensureEmbeddingJobsTable(sqlite);
  ensureImportJobsTable(sqlite);
  ensureSearchSchema(sqlite);
  sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
  globalForDb.schemaVersion = SCHEMA_VERSION;
}

const EMBEDDING_JOBS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS embedding_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'running',
    phase TEXT NOT NULL DEFAULT 'queued',
    processed INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    current_provider TEXT,
    error TEXT,
    message TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL DEFAULT (unixepoch()),
    finished_at INTEGER,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS embedding_jobs_state_idx
    ON embedding_jobs (state);
  CREATE INDEX IF NOT EXISTS embedding_jobs_started_idx
    ON embedding_jobs (started_at DESC);
`;

function ensureEmbeddingJobsTable(sqlite: Database.Database) {
  sqlite.exec(EMBEDDING_JOBS_SCHEMA);
}

const IMPORT_JOBS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS import_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    content_hash TEXT,
    spool_path TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'zip',
    state TEXT NOT NULL DEFAULT 'pending',
    phase TEXT NOT NULL DEFAULT 'queued',
    processed INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    message TEXT,
    error TEXT,
    details TEXT,
    result TEXT,
    import_id INTEGER REFERENCES imports(id),
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL DEFAULT (unixepoch()),
    finished_at INTEGER,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS import_jobs_state_idx
    ON import_jobs (state);
  CREATE INDEX IF NOT EXISTS import_jobs_started_idx
    ON import_jobs (started_at DESC);
`;

function ensureImportJobsTable(sqlite: Database.Database) {
  sqlite.exec(IMPORT_JOBS_SCHEMA);
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

  const likesFtsExists = sqlite
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'liked_items_fts'`,
    )
    .get();

  if (!likesFtsExists) {
    sqlite.exec(`
      CREATE VIRTUAL TABLE liked_items_fts USING fts5(
        author_username,
        shortcode,
        media_key,
        media_type,
        source,
        tokenize = 'porter unicode61 remove_diacritics 1'
      );
    `);
  }

  for (const index of ["local", "ollama", "openai", "voyage"] as const) {
    ensureVectorTable(sqlite, "saves", index);
    ensureVectorTable(sqlite, "likes", index);
  }
  migrateLegacyRemoteVectorTable(sqlite, legacyRemoteProvider);
}

function reclaimJobsAfterProcessRestart(sqlite: Database.Database) {
  // This is intentionally connection-startup work, not schema-ensure work:
  // HMR may re-run schema ensure while a real in-process job is still active.
  sqlite
    .prepare(
      `UPDATE embedding_jobs
       SET state = 'failed',
           error = COALESCE(error, 'Interrupted by server restart'),
           message = 'Job interrupted by server restart',
           finished_at = unixepoch(),
           updated_at = unixepoch()
       WHERE state = 'running'`,
    )
    .run();

  // Import jobs: re-queue when the spool file is still on disk; otherwise fail.
  // Full re-run from spool (idempotent merge) — not mid-phase resume.
  const orphaned = sqlite
    .prepare(
      `SELECT id, spool_path FROM import_jobs WHERE state = 'running'`,
    )
    .all() as Array<{ id: number; spool_path: string }>;

  for (const row of orphaned) {
    const spoolExists =
      typeof row.spool_path === "string" &&
      row.spool_path.length > 0 &&
      fs.existsSync(row.spool_path);

    if (spoolExists) {
      sqlite
        .prepare(
          `UPDATE import_jobs
           SET state = 'pending',
               phase = 'queued',
               cancel_requested = 0,
               message = 'Re-queued after server restart',
               error = NULL,
               finished_at = NULL,
               updated_at = unixepoch()
           WHERE id = ?`,
        )
        .run(row.id);
    } else {
      sqlite
        .prepare(
          `UPDATE import_jobs
           SET state = 'failed',
               error = 'Interrupted by server restart (upload spool missing)',
               message = 'Job interrupted by server restart',
               finished_at = unixepoch(),
               updated_at = unixepoch()
           WHERE id = ?`,
        )
        .run(row.id);
    }
  }
}

const PROFILE_INDEX_CHECK =
  "('local', 'ollama', 'openai', 'voyage', 'likes-local', 'likes-ollama', 'likes-openai', 'likes-voyage')";

const PROFILE_INDEX_NAMES = [
  "local",
  "ollama",
  "openai",
  "voyage",
  "likes-local",
  "likes-ollama",
  "likes-openai",
  "likes-voyage",
] as const;

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

  const needsRemoteMigration = table?.sql?.includes("'remote'") ?? false;
  const needsOllama =
    Boolean(table) && !(table?.sql?.includes("'ollama'") ?? false);
  const needsLikesProfiles =
    Boolean(table) && !(table?.sql?.includes("'likes-local'") ?? false);

  if (!table) {
    sqlite.exec(`
      CREATE TABLE embedding_index_profiles (
        index_name TEXT PRIMARY KEY CHECK (index_name IN ${PROFILE_INDEX_CHECK}),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        endpoint TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    return null;
  }

  if (!needsRemoteMigration && !needsOllama && !needsLikesProfiles) return null;

  const legacyRemote = needsRemoteMigration
    ? (sqlite
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
        | undefined)
    : undefined;

  const allowed = PROFILE_INDEX_NAMES.map((name) => `'${name}'`).join(", ");

  sqlite.exec(`
    CREATE TABLE embedding_index_profiles_new (
      index_name TEXT PRIMARY KEY CHECK (index_name IN ${PROFILE_INDEX_CHECK}),
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
    WHERE index_name IN (${allowed});
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
  library: "saves" | "likes",
  index: "local" | "ollama" | "openai" | "voyage",
) {
  const table =
    library === "saves"
      ? `saved_items_vec_${index}`
      : `liked_items_vec_${index}`;
  const profileKey = library === "saves" ? index : `likes-${index}`;
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
      DELETE FROM embedding_index_profiles WHERE index_name = '${profileKey}';
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

let schemaEnsuredForModule = false;

export function getSqlite() {
  if (!globalForDb.sqlite) {
    const sqlite = createDatabaseConnection();
    ensureDatabaseSchema(sqlite);
    reclaimJobsAfterProcessRestart(sqlite);
    globalForDb.sqlite = sqlite;
    schemaEnsuredForModule = true;
  } else if (!schemaEnsuredForModule) {
    const persistedVersion = globalForDb.sqlite.pragma("user_version", {
      simple: true,
    }) as number;
    if (
      process.env.NODE_ENV !== "production" ||
      globalForDb.schemaVersion !== SCHEMA_VERSION ||
      persistedVersion !== SCHEMA_VERSION
    ) {
      ensureDatabaseSchema(globalForDb.sqlite);
    }
    schemaEnsuredForModule = true;
  }
  return globalForDb.sqlite;
}

// Next.js preserves the connection on globalThis across HMR. Re-ensure once as
// soon as this module is re-evaluated so newly added idempotent DDL takes effect
// without opening another Database handle or requiring a server restart.
if (globalForDb.sqlite && process.env.NODE_ENV !== "production") {
  ensureDatabaseSchema(globalForDb.sqlite);
  schemaEnsuredForModule = true;
}

export function getDb() {
  if (!globalForDb.db) {
    globalForDb.db = drizzle(getSqlite(), { schema });
  }
  return globalForDb.db;
}

/**
 * Drop and recreate empty FTS + vector indexes so the app stays usable after
 * a content wipe. Does not touch `app_settings` or keyring secrets.
 */
export function recreateEmptySearchIndexes(
  sqlite: Database.Database = getSqlite(),
) {
  sqlite.exec(`
    DROP TABLE IF EXISTS saved_items_fts;
    CREATE VIRTUAL TABLE saved_items_fts USING fts5(
      author_username,
      shortcode,
      media_key,
      media_type,
      collections,
      tokenize = 'porter unicode61 remove_diacritics 1'
    );
  `);

  sqlite.exec(`
    DROP TABLE IF EXISTS liked_items_fts;
    CREATE VIRTUAL TABLE liked_items_fts USING fts5(
      author_username,
      shortcode,
      media_key,
      media_type,
      source,
      tokenize = 'porter unicode61 remove_diacritics 1'
    );
  `);

  for (const index of ["local", "ollama", "openai", "voyage"] as const) {
    for (const prefix of ["saved_items_vec", "liked_items_vec"] as const) {
      const table = `${prefix}_${index}`;
      sqlite.exec(`
        DROP TABLE IF EXISTS ${table};
        CREATE VIRTUAL TABLE ${table} USING vec0(
          item_id INTEGER PRIMARY KEY,
          embedding FLOAT[${VEC_DIMENSIONS}]
        );
      `);
    }
  }

  sqlite.exec(`DROP TABLE IF EXISTS saved_items_vec_remote;`);
}

export { schema };
