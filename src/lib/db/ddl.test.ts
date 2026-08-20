import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, ensureDatabaseSchema } from "./ddl";

const openDatabases: Database.Database[] = [];

function openMemoryDatabase(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqliteVec.load(sqlite);
  openDatabases.push(sqlite);
  return sqlite;
}

afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

describe("greenfield Drizzle bootstrap", () => {
  it("migrates and stamps an empty database idempotently", () => {
    const sqlite = openMemoryDatabase();

    ensureDatabaseSchema(sqlite);
    ensureDatabaseSchema(sqlite);

    expect(sqlite.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    const tables = (
      sqlite
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND name IN (
               '__drizzle_migrations',
               'imports',
               'app_settings',
               'embedding_jobs',
               'import_jobs',
               'embedding_index_profiles',
               'saved_items_fts',
               'saved_items_vec_local'
             )
           ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);

    expect(tables).toEqual([
      "__drizzle_migrations",
      "app_settings",
      "embedding_index_profiles",
      "embedding_jobs",
      "import_jobs",
      "imports",
      "saved_items_fts",
      "saved_items_vec_local",
    ]);
  });

  it("rejects a legacy version instead of upgrading it", () => {
    const sqlite = openMemoryDatabase();
    sqlite.exec(`CREATE TABLE imports (id INTEGER PRIMARY KEY)`);
    sqlite.pragma("user_version = 9");

    expect(() => ensureDatabaseSchema(sqlite)).toThrow(/fresh database/i);
  });

  it("rejects an unstamped non-empty version-zero database", () => {
    const sqlite = openMemoryDatabase();
    sqlite.exec(`CREATE TABLE stray_data (id INTEGER PRIMARY KEY)`);

    expect(() => ensureDatabaseSchema(sqlite)).toThrow(/unstamped non-empty/i);
  });
});
