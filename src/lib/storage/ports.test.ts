/**
 * ME-1 port-boundary tests: construct SQLite storage directly over :memory:.
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearStorageCache,
  closeStorage,
  createSqliteStorage,
  ensureDatabaseSchema,
  getStorage,
  installSqliteConnectionForTests,
} from "./index";
import { LibraryBusyError } from "../settings/library-busy";

function openMemoryDb(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqliteVec.load(sqlite);
  ensureDatabaseSchema(sqlite);
  installSqliteConnectionForTests(sqlite);
  clearStorageCache();
  return sqlite;
}

afterEach(() => {
  clearStorageCache();
  closeStorage();
});

describe("storage ports (SQLite)", () => {
  it("createSqliteStorage exposes all five ports", () => {
    const sqlite = openMemoryDb();
    const storage = createSqliteStorage(sqlite);
    expect(storage.catalog).toBeDefined();
    expect(storage.search).toBeDefined();
    expect(storage.jobs).toBeDefined();
    expect(storage.settings).toBeDefined();
    expect(storage.maintenance).toBeDefined();
  });

  it("getStorage caches and returns sqlite engineInfo", async () => {
    openMemoryDb();
    const a = await getStorage();
    const b = await getStorage();
    expect(a).toBe(b);
    const info = await a.maintenance.engineInfo();
    expect(info.engine).toBe("sqlite");
    expect(info.searchTech.keyword).toBe("FTS5");
    expect(info.searchTech.vector).toBe("sqlite-vec");
    expect(info.maintenanceActions).toEqual(["checkpoint", "vacuum"]);
  });

  it("SettingsStore round-trips app_settings on the bound handle", async () => {
    const sqlite = openMemoryDb();
    const storage = createSqliteStorage(sqlite);

    await storage.settings.setAppSetting("embedding_timeout_ms", "12345");
    expect(await storage.settings.getAppSetting("embedding_timeout_ms")).toBe(
      "12345",
    );
    expect(await storage.settings.getEmbeddingTimeoutMs()).toBe(12345);

    const row = sqlite
      .prepare(`SELECT value FROM app_settings WHERE key = ?`)
      .get("embedding_timeout_ms") as { value: string };
    expect(row.value).toBe("12345");
  });

  it("SearchIndex FTS upsert + count uses the injected sqlite", async () => {
    const sqlite = openMemoryDb();
    const storage = createSqliteStorage(sqlite);

    expect(await storage.search.ftsCount("saves")).toBe(0);

    sqlite
      .prepare(
        `INSERT INTO imports (filename, content_hash, status)
         VALUES ('t.zip', 'hash', 'completed')`,
      )
      .run();
    const importId = (
      sqlite.prepare(`SELECT id FROM imports`).get() as { id: number }
    ).id;
    sqlite
      .prepare(
        `INSERT INTO saved_items (
          media_key, href, shortcode, media_type, author_username,
          first_seen_import_id, last_seen_import_id
        ) VALUES ('k1', 'https://instagram.com/p/abc', 'abc', 'post', 'alice', ?, ?)`,
      )
      .run(importId, importId);
    const itemId = (
      sqlite.prepare(`SELECT id FROM saved_items`).get() as { id: number }
    ).id;

    await storage.search.upsertItemFts(itemId, {
      authorUsername: "alice",
      shortcode: "abc",
      mediaKey: "k1",
      mediaType: "post",
      collections: ["All posts"],
    });

    expect(await storage.search.ftsCount("saves")).toBe(1);
    const fts = await storage.search.searchFts("saves", "alice", 10);
    expect(fts.degraded).toBe(false);
    expect(fts.hits.map((h) => h.id)).toContain(itemId);
  });

  it("MaintenanceOps refuses checkpoint while jobs are active", async () => {
    const sqlite = openMemoryDb();
    const storage = createSqliteStorage(sqlite);

    sqlite
      .prepare(
        `INSERT INTO import_jobs (filename, spool_path, kind, state)
         VALUES ('busy.zip', '/tmp/x', 'zip', 'running')`,
      )
      .run();

    const busy = await storage.maintenance.getLibraryBusyState("run VACUUM");
    expect(busy.busy).toBe(true);

    await expect(
      storage.maintenance.runMaintenance("checkpoint"),
    ).rejects.toBeInstanceOf(LibraryBusyError);
  });

  it("MaintenanceOps checkIntegrity reports ok on a fresh schema", async () => {
    const sqlite = openMemoryDb();
    const storage = createSqliteStorage(sqlite);
    const result = await storage.maintenance.checkIntegrity();
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("ok");
  });

  it("JobStore reclaim on empty tables is a no-op", async () => {
    const sqlite = openMemoryDb();
    const storage = createSqliteStorage(sqlite);
    const embedding = await storage.jobs.reclaimOrphanedEmbeddingJobs();
    const imports = await storage.jobs.reclaimOrphanedImportJobs();
    expect(embedding).toEqual(
      expect.objectContaining({
        cancelled: 0,
        resumed: 0,
      }),
    );
    expect(imports).toEqual(
      expect.objectContaining({
        requeued: 0,
        failed: 0,
      }),
    );
  });
});
