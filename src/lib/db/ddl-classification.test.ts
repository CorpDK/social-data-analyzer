import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";
import {
  DatabaseSchemaError,
  ensureDatabaseSchema,
} from "./ddl";

const openDatabases: Database.Database[] = [];

function database(withVector = true) {
  const sqlite = new Database(":memory:");
  if (withVector) sqliteVec.load(sqlite);
  openDatabases.push(sqlite);
  return sqlite;
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("schema update classification", () => {
  it("classifies a first apply and an idempotent reopen", () => {
    const sqlite = database();

    expect(ensureDatabaseSchema(sqlite)).toMatchObject({
      state: "migrated",
      pendingMigrations: 0,
    });
    expect(ensureDatabaseSchema(sqlite)).toMatchObject({
      state: "up_to_date",
      pendingMigrations: 0,
    });
  });

  it("classifies a generation break without running migrations", () => {
    const sqlite = database();
    sqlite.exec("CREATE TABLE legacy (id INTEGER PRIMARY KEY)");
    sqlite.pragma("user_version = 9");

    expect(() => ensureDatabaseSchema(sqlite)).toThrowError(
      expect.objectContaining<Partial<DatabaseSchemaError>>({
        code: "generation_break",
      }),
    );
    expect(
      sqlite
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations'",
        )
        .get(),
    ).toBeUndefined();
  });

  it("classifies an update apply failure", () => {
    const sqlite = database(false);

    expect(() => ensureDatabaseSchema(sqlite)).toThrowError(
      expect.objectContaining<Partial<DatabaseSchemaError>>({
        code: "apply_failed",
      }),
    );
  });
});
