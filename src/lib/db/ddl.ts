/**
 * Greenfield SQLite bootstrap.
 *
 * Drizzle Kit migrations own ordinary tables. This module owns only the
 * SQLite-specific FTS5/vec0 virtual tables and the clean-break version stamp.
 */
import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";

/** Fixed sqlite-vec embedding width for all provider tables. */
export const VEC_DIMENSIONS = 1024;

/**
 * v11 is the canonical-media generation. Earlier populated libraries are
 * intentionally unsupported: delete the database and start with a fresh import.
 */
export const SCHEMA_VERSION = 11;

const SQLITE_MIGRATIONS_FOLDER = path.join(
  process.cwd(),
  "drizzle",
  "sqlite",
);

export type DatabaseSchemaState = "up_to_date" | "migrated";

export type DatabaseSchemaOutcome = {
  state: DatabaseSchemaState;
  appliedMigrations: number;
  pendingMigrations: number;
};

export type DatabaseSchemaFailure = "generation_break" | "apply_failed";

export class DatabaseSchemaError extends Error {
  constructor(
    readonly code: DatabaseSchemaFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DatabaseSchemaError";
  }
}

function tableExists(sqlite: Database.Database, table: string): boolean {
  return Boolean(
    sqlite
      .prepare(
        `SELECT 1
         FROM sqlite_master
         WHERE type = 'table' AND name = ?`,
      )
      .get(table),
  );
}

function ordinaryApplicationTables(sqlite: Database.Database): string[] {
  return (
    sqlite
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
           AND name <> '__drizzle_migrations'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

export function assertDatabaseGenerationSupported(
  sqlite: Database.Database,
): void {
  const version = sqlite.pragma("user_version", { simple: true }) as number;
  const hasMigrationJournal = tableExists(sqlite, "__drizzle_migrations");

  if (version !== 0 && version !== SCHEMA_VERSION) {
    throw new DatabaseSchemaError(
      "generation_break",
      `Unsupported SQLite schema version ${version}. ` +
        `Schema v11 requires a fresh database; delete the configured SQLite file and re-import.`,
    );
  }

  if (
    (version === 0 && !hasMigrationJournal && ordinaryApplicationTables(sqlite).length > 0) ||
    (version === SCHEMA_VERSION && !hasMigrationJournal)
  ) {
    throw new DatabaseSchemaError(
      "generation_break",
      "Unstamped non-empty SQLite database detected. " +
        "Schema v11 does not upgrade legacy databases; delete the configured SQLite file and re-import.",
    );
  }
}

function migrationCount(): number {
  return fs
    .readdirSync(SQLITE_MIGRATIONS_FOLDER)
    .filter((filename) => /^\d+.*\.sql$/.test(filename)).length;
}

function appliedMigrationCount(sqlite: Database.Database): number {
  if (!tableExists(sqlite, "__drizzle_migrations")) return 0;
  const row = sqlite
    .prepare("SELECT count(*) AS count FROM __drizzle_migrations")
    .get() as { count: number };
  return row.count;
}

/**
 * Apply pending plain-table migrations, then ensure engine-specific search
 * objects. Safe to call repeatedly for a v11 database.
 */
export function ensureDatabaseSchema(
  sqlite: Database.Database,
): DatabaseSchemaOutcome {
  try {
    assertDatabaseGenerationSupported(sqlite);
    const before = appliedMigrationCount(sqlite);
    migrate(drizzle(sqlite), { migrationsFolder: SQLITE_MIGRATIONS_FOLDER });
    ensureSearchSchema(sqlite);
    sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
    const appliedMigrations = appliedMigrationCount(sqlite);
    return {
      state: appliedMigrations > before ? "migrated" : "up_to_date",
      appliedMigrations,
      pendingMigrations: Math.max(0, migrationCount() - appliedMigrations),
    };
  } catch (error) {
    if (error instanceof DatabaseSchemaError) throw error;
    throw new DatabaseSchemaError(
      "apply_failed",
      error instanceof Error ? error.message : "SQLite schema update failed.",
      { cause: error },
    );
  }
}

const FTS_TOKENIZE = "porter unicode61 remove_diacritics 1";

/** Single-source FTS5 DDL for saves (used by ensure + recreate). */
export const SAVED_ITEMS_FTS_CREATE_SQL = `CREATE VIRTUAL TABLE saved_items_fts USING fts5(
  author_username,
  shortcode,
  media_key,
  media_type,
  collections,
  tokenize = '${FTS_TOKENIZE}'
)`;

/** Single-source FTS5 DDL for likes (used by ensure + recreate). */
export const LIKED_ITEMS_FTS_CREATE_SQL = `CREATE VIRTUAL TABLE liked_items_fts USING fts5(
  author_username,
  shortcode,
  media_key,
  media_type,
  source,
  tokenize = '${FTS_TOKENIZE}'
)`;

const VECTOR_INDEXES = ["local", "ollama", "openai", "voyage"] as const;

function vectorTableCreateSql(
  library: "saves" | "likes",
  index: (typeof VECTOR_INDEXES)[number],
): { table: string; sql: string } {
  const table =
    library === "saves"
      ? `saved_items_vec_${index}`
      : `liked_items_vec_${index}`;
  return {
    table,
    sql: `CREATE VIRTUAL TABLE ${table} USING vec0(
  item_id INTEGER PRIMARY KEY,
  embedding FLOAT[${VEC_DIMENSIONS}]
)`,
  };
}

/** Ensure SQLite-only virtual search tables after plain-table migrations. */
export function ensureSearchSchema(sqlite: Database.Database): void {
  if (!tableExists(sqlite, "saved_items_fts")) {
    sqlite.exec(SAVED_ITEMS_FTS_CREATE_SQL);
  }
  if (!tableExists(sqlite, "liked_items_fts")) {
    sqlite.exec(LIKED_ITEMS_FTS_CREATE_SQL);
  }

  for (const index of VECTOR_INDEXES) {
    for (const library of ["saves", "likes"] as const) {
      const { table, sql } = vectorTableCreateSql(library, index);
      if (!tableExists(sqlite, table)) {
        sqlite.exec(sql);
      }
    }
  }
}

/**
 * Drop and recreate empty FTS + vector indexes after a content wipe.
 * Ordinary tables and the Drizzle journal remain untouched.
 */
export function recreateEmptySearchIndexes(sqlite: Database.Database): void {
  sqlite.exec(`
    DROP TABLE IF EXISTS saved_items_fts;
    ${SAVED_ITEMS_FTS_CREATE_SQL};
    DROP TABLE IF EXISTS liked_items_fts;
    ${LIKED_ITEMS_FTS_CREATE_SQL};
  `);

  for (const index of VECTOR_INDEXES) {
    for (const library of ["saves", "likes"] as const) {
      const { table, sql } = vectorTableCreateSql(library, index);
      sqlite.exec(`
        DROP TABLE IF EXISTS ${table};
        ${sql};
      `);
    }
  }
}
