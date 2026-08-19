import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  assertLibraryIdle,
  assertLibraryIdleForReset,
  getLibraryBusyState,
  LibraryBusyError,
} from "./library-busy";

function memoryBusyDb(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE import_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      spool_path TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'zip',
      state TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE embedding_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending'
    );
  `);
  return sqlite;
}

describe("getLibraryBusyState / assertLibraryIdleForReset", () => {
  it("reports idle when no pending/running jobs", () => {
    const sqlite = memoryBusyDb();
    sqlite
      .prepare(
        `INSERT INTO import_jobs (filename, state) VALUES ('done.zip', 'completed')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO embedding_jobs (target, state) VALUES ('saves:local', 'cancelled')`,
      )
      .run();

    expect(getLibraryBusyState(sqlite)).toEqual({ busy: false });
    expect(() => assertLibraryIdleForReset(sqlite)).not.toThrow();
  });

  it("throws LibraryBusyError (409) when import or embedding work is open", () => {
    const sqlite = memoryBusyDb();
    sqlite
      .prepare(
        `INSERT INTO import_jobs (filename, state) VALUES ('big.zip', 'running')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO embedding_jobs (target, state) VALUES ('saves:voyage', 'pending')`,
      )
      .run();

    const state = getLibraryBusyState(sqlite);
    expect(state.busy).toBe(true);
    if (!state.busy) throw new Error("expected busy");
    expect(state.jobs).toHaveLength(2);
    expect(state.reason).toMatch(/Cannot reset library while jobs are active/);

    try {
      assertLibraryIdleForReset(sqlite);
      throw new Error("expected LibraryBusyError");
    } catch (error) {
      expect(error).toBeInstanceOf(LibraryBusyError);
      expect((error as LibraryBusyError).status).toBe(409);
      expect((error as LibraryBusyError).message).toMatch(/import #1/);
      expect((error as LibraryBusyError).message).toMatch(/embedding #1/);
    }

    try {
      assertLibraryIdle(sqlite, "run VACUUM");
      throw new Error("expected LibraryBusyError");
    } catch (error) {
      expect(error).toBeInstanceOf(LibraryBusyError);
      expect((error as LibraryBusyError).message).toMatch(/Cannot run VACUUM/);
    }
  });
});
