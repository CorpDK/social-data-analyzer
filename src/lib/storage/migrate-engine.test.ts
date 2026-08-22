import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  createPostgresPool,
  createPostgresStorage,
} from "./index";
import {
  assertPostgresMigrationUsable,
  INCOMPLETE_ENGINE_MIGRATION_MESSAGE,
  postgresEngineMigrationStatus,
} from "./postgres/engine-migration";
import {
  countSqliteFileIfExists,
  EngineMigrationAbortError,
  openSqliteDatabase,
  removeSqliteRelatedFiles,
  replaceSqliteDatabaseFile,
  runEngineMigration,
  SQLITE_STAGING_SUFFIX,
  sqliteStagingPath,
  sqliteTargetCount,
} from "../../../scripts/migrate-engine";

const tempDirs: string[] = [];
const adminPools: Pool[] = [];
const tempDatabaseNames: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-engine-"));
  tempDirs.push(dir);
  return dir;
}

function seedSqliteLibrary(file: string): void {
  const sqlite = openSqliteDatabase(file, "target");
  try {
    sqlite.exec(`
      INSERT INTO imports (
        id, filename, content_hash, imported_at, items_found, items_added,
        items_updated, items_skipped, status
      ) VALUES (1, 'seed.json', 'migrate-engine-seed', unixepoch(), 1, 1, 0, 0, 'completed');
      INSERT INTO saved_items (
        id, media_key, href, shortcode, media_type, author_username, saved_at,
        first_seen_import_id, last_seen_import_id, created_at, updated_at
      ) VALUES (
        1, 'save-one', 'https://www.instagram.com/p/SaveOne/', 'SaveOne', 'post',
        'alice', unixepoch(), 1, 1, unixepoch(), unixepoch()
      );
      INSERT INTO item_collections (id, item_id, collection_name)
      VALUES (1, 1, 'Recipes');
    `);
  } finally {
    sqlite.close();
  }
}

function quoteIdent(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Unsafe database name: ${name}`);
  return `"${name}"`;
}

function withDatabaseName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

async function createIsolatedPostgres(
  baseUrl: string,
): Promise<{ url: string; name: string } | null> {
  const admin = new Pool({ connectionString: baseUrl });
  const name = `migrate_engine_t_${process.pid}_${Date.now().toString(36)}`;
  try {
    await admin.query(`CREATE DATABASE ${quoteIdent(name)}`);
  } catch (error) {
    await admin.end().catch(() => undefined);
    console.info(
      `[migrate-engine.test] skipping Postgres: cannot CREATE DATABASE (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return null;
  }
  adminPools.push(admin);
  tempDatabaseNames.push(name);
  return { url: withDatabaseName(baseUrl, name), name };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  const admin = adminPools[0];
  while (tempDatabaseNames.length > 0) {
    const name = tempDatabaseNames.pop();
    if (admin && name) {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    }
  }
  while (adminPools.length > 0) {
    await adminPools.pop()?.end().catch(() => undefined);
  }
});

describe("migrate:engine SQLite staging", () => {
  it("abort mid-copy leaves dest unused and retry replaces the file", () => {
    const dest = path.join(tempDir(), "library.db");
    const staging = sqliteStagingPath(dest);

    const aborted = openSqliteDatabase(staging, "target");
    aborted
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, unixepoch())`,
      )
      .run("theme", "dark");
    aborted.close();

    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(staging)).toBe(true);
    expect(countSqliteFileIfExists(staging)).toBeGreaterThan(0);

    removeSqliteRelatedFiles(staging);
    expect(fs.existsSync(staging)).toBe(false);

    const retry = openSqliteDatabase(staging, "target");
    retry
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, unixepoch())`,
      )
      .run("theme", "light");
    retry.close();
    replaceSqliteDatabaseFile(staging, dest);

    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.existsSync(dest)).toBe(true);
    const opened = openSqliteDatabase(dest, "source");
    try {
      const row = opened
        .prepare(`SELECT value FROM app_settings WHERE key = ?`)
        .get("theme") as { value: string };
      expect(row.value).toBe("light");
      expect(sqliteTargetCount(opened)).toBeGreaterThan(0);
    } finally {
      opened.close();
    }
  });

  it("uses the engine-migrate suffix beside the destination", () => {
    expect(sqliteStagingPath("/tmp/library.db")).toBe(
      `/tmp/library.db${SQLITE_STAGING_SUFFIX}`,
    );
  });
});

const postgresUrl = process.env.INSTAGRAM_SAVES_DATABASE_URL?.trim();

describe.skipIf(!postgresUrl).sequential("migrate:engine interrupt then retry", () => {
  it("sqlite -> postgres abort inside the copy transaction then retry", async () => {
    const isolated = await createIsolatedPostgres(postgresUrl!);
    if (!isolated) return;

    const source = path.join(tempDir(), "source.db");
    await seedSqliteLibrary(source);
    const options = {
      from: "sqlite" as const,
      to: "postgres" as const,
      sqlitePath: source,
      postgresUrl: isolated.url,
      includeJobs: false,
    };

    await expect(
      runEngineMigration(options, { afterTable: "imports" }),
    ).rejects.toBeInstanceOf(EngineMigrationAbortError);

    const interrupted = await createPostgresPool(isolated.url, {
      allowIncompleteMigration: true,
    });
    try {
      expect(await postgresEngineMigrationStatus(interrupted)).toBe("in_progress");
      const count = await interrupted.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM saved_items",
      );
      expect(count.rows[0]?.n).toBe(0);
      await expect(assertPostgresMigrationUsable(interrupted)).rejects.toThrow(
        INCOMPLETE_ENGINE_MIGRATION_MESSAGE,
      );
    } finally {
      await interrupted.end();
    }

    await runEngineMigration(options);

    const completed = await createPostgresPool(isolated.url);
    try {
      expect(await postgresEngineMigrationStatus(completed)).toBe("complete");
      await assertPostgresMigrationUsable(completed);
      const storage = createPostgresStorage(completed);
      expect((await storage.catalog.getStats()).totalItems).toBe(1);
    } finally {
      await completed.end();
    }
  });

  it("sqlite -> postgres abort after commit then retry wipes the incomplete target", async () => {
    const isolated = await createIsolatedPostgres(postgresUrl!);
    if (!isolated) return;

    const source = path.join(tempDir(), "source.db");
    await seedSqliteLibrary(source);
    const options = {
      from: "sqlite" as const,
      to: "postgres" as const,
      sqlitePath: source,
      postgresUrl: isolated.url,
      includeJobs: false,
    };

    await expect(
      runEngineMigration(options, { afterPhase: "copy" }),
    ).rejects.toBeInstanceOf(EngineMigrationAbortError);

    const interrupted = await createPostgresPool(isolated.url, {
      allowIncompleteMigration: true,
    });
    try {
      expect(await postgresEngineMigrationStatus(interrupted)).toBe("in_progress");
      const count = await interrupted.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM saved_items",
      );
      expect(count.rows[0]?.n).toBe(1);
      await expect(assertPostgresMigrationUsable(interrupted)).rejects.toThrow(
        /incomplete migrate:engine/i,
      );
    } finally {
      await interrupted.end();
    }

    await runEngineMigration(options);

    const completed = await createPostgresPool(isolated.url);
    try {
      expect(await postgresEngineMigrationStatus(completed)).toBe("complete");
      const storage = createPostgresStorage(completed);
      expect((await storage.catalog.getStats()).totalItems).toBe(1);
    } finally {
      await completed.end();
    }
  });

  it("postgres -> sqlite abort leaves dest missing then retry replaces it", async () => {
    const isolated = await createIsolatedPostgres(postgresUrl!);
    if (!isolated) return;

    const seedPool = await createPostgresPool(isolated.url);
    try {
      const storage = createPostgresStorage(seedPool);
      const imported = await storage.catalog.createImport({
        filename: "seed.json",
        contentHash: "pg-seed",
        status: "completed",
        itemsFound: 1,
      });
      await storage.catalog.applyParsedItems(imported.id, [
        {
          mediaKey: "save-pg",
          href: "https://www.instagram.com/p/SavePg/",
          shortcode: "SavePg",
          mediaType: "post",
          authorUsername: "bob",
          savedAt: new Date("2026-01-02T00:00:00.000Z"),
          collections: ["Travel"],
        },
      ]);
    } finally {
      await seedPool.end();
    }

    const dest = path.join(tempDir(), "new-library.db");
    const options = {
      from: "postgres" as const,
      to: "sqlite" as const,
      sqlitePath: dest,
      postgresUrl: isolated.url,
      includeJobs: false,
    };

    await expect(
      runEngineMigration(options, { afterTable: "imports" }),
    ).rejects.toBeInstanceOf(EngineMigrationAbortError);

    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(sqliteStagingPath(dest))).toBe(false);

    await runEngineMigration(options);
    expect(fs.existsSync(dest)).toBe(true);
    expect(countSqliteFileIfExists(dest)).toBeGreaterThan(0);
  });
});
