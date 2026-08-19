import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseDbMaintenanceAction,
  runDbMaintenance,
} from "./db-maintenance";
import { LibraryBusyError } from "./library-busy";
import {
  createSqliteStorage,
  installSqliteConnectionForTests,
  closeStorage,
} from "../storage";

const sqliteHolders: Database.Database[] = [];

function installMemoryDb(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
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
    CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);
  `);
  sqlite.exec(`INSERT INTO t (v) VALUES ('a'), ('b'), ('c')`);
  installSqliteConnectionForTests(sqlite);
  createSqliteStorage(sqlite);
  sqliteHolders.push(sqlite);
  return sqlite;
}

afterEach(() => {
  closeStorage();
  while (sqliteHolders.length > 0) {
    try {
      sqliteHolders.pop()?.close();
    } catch {
      // already closed by closeStorage
    }
  }
});

describe("parseDbMaintenanceAction", () => {
  it("accepts checkpoint and vacuum only", () => {
    expect(parseDbMaintenanceAction("checkpoint")).toBe("checkpoint");
    expect(parseDbMaintenanceAction("vacuum")).toBe("vacuum");
    expect(parseDbMaintenanceAction("truncate")).toBeNull();
    expect(parseDbMaintenanceAction(1)).toBeNull();
  });
});

describe("runDbMaintenance", () => {
  it("runs WAL checkpoint when idle", async () => {
    const sqlite = installMemoryDb();
    const storage = createSqliteStorage(sqlite);
    const result = await storage.maintenance.runMaintenance("checkpoint");
    expect(result.ok).toBe(true);
    expect(result.action).toBe("checkpoint");
    expect(result.walCheckpoint).toEqual(
      expect.objectContaining({
        busy: expect.any(Number),
        log: expect.any(Number),
        checkpointed: expect.any(Number),
      }),
    );
    expect(result.pageCount).toBeGreaterThan(0);
  });

  it("runs VACUUM when idle", async () => {
    const sqlite = installMemoryDb();
    const result = runDbMaintenance("vacuum", sqlite);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("vacuum");
    expect(result.vacuumMs).toBeGreaterThanOrEqual(0);
    expect(result.pageCount).toBeGreaterThan(0);
  });

  it("refuses with LibraryBusyError while jobs are active", () => {
    const sqlite = installMemoryDb();
    sqlite
      .prepare(
        `INSERT INTO import_jobs (filename, state) VALUES ('busy.zip', 'running')`,
      )
      .run();

    expect(() => runDbMaintenance("checkpoint", sqlite)).toThrow(
      LibraryBusyError,
    );
    try {
      runDbMaintenance("vacuum", sqlite);
      throw new Error("expected LibraryBusyError");
    } catch (error) {
      expect(error).toBeInstanceOf(LibraryBusyError);
      expect((error as LibraryBusyError).message).toMatch(/Cannot run VACUUM/);
    }
  });
});
