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
const tempSchemaNames: string[] = [];

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
      INSERT INTO media (
        id, media_key, href, shortcode, media_type, author_username,
        created_at, updated_at
      ) VALUES (
        1, 'save-one', 'https://www.instagram.com/p/SaveOne/', 'SaveOne', 'post',
        'alice', unixepoch(), unixepoch()
      );
      INSERT INTO saved (
        media_id, saved_at, first_seen_import_id, last_seen_import_id,
        created_at, updated_at
      ) VALUES (1, unixepoch(), 1, 1, unixepoch(), unixepoch());
      INSERT INTO liked (
        media_id, liked_at, source, first_seen_import_id, last_seen_import_id,
        created_at, updated_at
      ) VALUES (
        1, unixepoch(), 'liked_posts', 1, 1, unixepoch(), unixepoch()
      );
      INSERT INTO item_collections (id, item_id, collection_name)
      VALUES (1, 1, 'Recipes');
      INSERT INTO embedding_index_profiles (
        index_name, provider, model, dimensions, endpoint, updated_at
      ) VALUES
        ('local', 'local', 'feature-hash-v1', 1024, NULL, unixepoch()),
        ('likes-local', 'local', 'feature-hash-v1', 1024, NULL, unixepoch());
    `);
    const vector = Buffer.alloc(1024 * Float32Array.BYTES_PER_ELEMENT);
    vector.writeFloatLE(1, 0);
    sqlite
      .prepare(
        "INSERT INTO saved_items_vec_local(item_id, embedding) VALUES (?, ?)",
      )
      .run(1, vector);
    sqlite
      .prepare(
        "INSERT INTO liked_items_vec_local(item_id, embedding) VALUES (?, ?)",
      )
      .run(1, vector);
  } finally {
    sqlite.close();
  }
}

function quoteIdent(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Unsafe database name: ${name}`);
  return `"${name}"`;
}

async function createIsolatedPostgres(
  baseUrl: string,
): Promise<{ url: string; schema: string } | null> {
  const admin = new Pool({ connectionString: baseUrl });
  const schema = `migrate_engine_t_${process.pid}_${Date.now().toString(36)}`;
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
  } catch (error) {
    await admin.end().catch(() => undefined);
    console.info(
      `[migrate-engine.test] skipping Postgres: cannot CREATE SCHEMA (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return null;
  }
  adminPools.push(admin);
  tempSchemaNames.push(schema);
  return { url: baseUrl, schema };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  const admin = adminPools[0];
  while (tempSchemaNames.length > 0) {
    const schema = tempSchemaNames.pop();
    if (admin && schema) {
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
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
      postgresSchema: isolated.schema,
      includeJobs: false,
    };

    await expect(
      runEngineMigration(options, { afterTable: "imports" }),
    ).rejects.toBeInstanceOf(EngineMigrationAbortError);

    const interrupted = await createPostgresPool(isolated.url, {
      allowIncompleteMigration: true,
      postgresSchema: isolated.schema,
    });
    try {
      expect(
        await postgresEngineMigrationStatus(interrupted, isolated.schema),
      ).toBe("in_progress");
      const count = await interrupted.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM saved",
      );
      expect(count.rows[0]?.n).toBe(0);
      await expect(
        assertPostgresMigrationUsable(interrupted, isolated.schema),
      ).rejects.toThrow(INCOMPLETE_ENGINE_MIGRATION_MESSAGE);
    } finally {
      await interrupted.end();
    }

    await runEngineMigration(options);

    const completed = await createPostgresPool(isolated.url, {
      postgresSchema: isolated.schema,
    });
    try {
      expect(
        await postgresEngineMigrationStatus(completed, isolated.schema),
      ).toBe("complete");
      await assertPostgresMigrationUsable(completed, isolated.schema);
      const storage = createPostgresStorage(completed);
      expect((await storage.catalog.getStats()).totalItems).toBe(1);
      const copied = await completed.query<{
        media_id: number;
        saved: boolean;
        liked: boolean;
        embeddings: number;
      }>(`
        SELECT m.id AS media_id,
          EXISTS (SELECT 1 FROM saved s WHERE s.media_id=m.id) AS saved,
          EXISTS (SELECT 1 FROM liked l WHERE l.media_id=m.id) AS liked,
          (SELECT count(*)::int FROM media_embeddings e
            WHERE e.media_id=m.id AND e.provider='local') AS embeddings
        FROM media m
      `);
      expect(copied.rows).toEqual([
        { media_id: 1, saved: true, liked: true, embeddings: 1 },
      ]);
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
      postgresSchema: isolated.schema,
      includeJobs: false,
    };

    await expect(
      runEngineMigration(options, { afterPhase: "copy" }),
    ).rejects.toBeInstanceOf(EngineMigrationAbortError);

    const interrupted = await createPostgresPool(isolated.url, {
      allowIncompleteMigration: true,
      postgresSchema: isolated.schema,
    });
    try {
      expect(
        await postgresEngineMigrationStatus(interrupted, isolated.schema),
      ).toBe("in_progress");
      const count = await interrupted.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM saved",
      );
      expect(count.rows[0]?.n).toBe(1);
      await expect(
        assertPostgresMigrationUsable(interrupted, isolated.schema),
      ).rejects.toThrow(/incomplete migrate:engine/i);
    } finally {
      await interrupted.end();
    }

    await runEngineMigration(options);

    const completed = await createPostgresPool(isolated.url, {
      postgresSchema: isolated.schema,
    });
    try {
      expect(
        await postgresEngineMigrationStatus(completed, isolated.schema),
      ).toBe("complete");
      const storage = createPostgresStorage(completed);
      expect((await storage.catalog.getStats()).totalItems).toBe(1);
    } finally {
      await completed.end();
    }
  });

  it("postgres -> sqlite abort leaves dest missing then retry replaces it", async () => {
    const isolated = await createIsolatedPostgres(postgresUrl!);
    if (!isolated) return;

    const seedPool = await createPostgresPool(isolated.url, {
      postgresSchema: isolated.schema,
    });
    try {
      const storage = createPostgresStorage(seedPool);
      const imported = await storage.catalog.createImport({
        filename: "seed.json",
        contentHash: "pg-seed",
        status: "completed",
        itemsFound: 1,
      });
      const saved = await storage.catalog.applyParsedItems(imported.id, [
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
      await storage.catalog.applyLikedItems(imported.id, [
        {
          mediaKey: "save-pg",
          href: "https://www.instagram.com/p/SavePg/",
          shortcode: "SavePg",
          mediaType: "post",
          authorUsername: "bob",
          likedAt: new Date("2026-01-03T00:00:00.000Z"),
          source: "liked_posts",
        },
      ]);
      for (const library of ["saves", "likes"] as const) {
        await storage.search.writeEmbeddingProfile(library, "local", {
          provider: "local",
          model: "feature-hash-v1",
          dimensions: 1024,
          endpoint: null,
        });
      }
      const vector = new Float32Array(1024);
      vector[0] = 1;
      await storage.search.upsertItemEmbedding(
        "saves",
        "local",
        saved.changedIds[0]!,
        vector,
      );
    } finally {
      await seedPool.end();
    }

    const dest = path.join(tempDir(), "new-library.db");
    const options = {
      from: "postgres" as const,
      to: "sqlite" as const,
      sqlitePath: dest,
      postgresUrl: isolated.url,
      postgresSchema: isolated.schema,
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
    const copied = openSqliteDatabase(dest, "source");
    try {
      expect(
        (
          copied
            .prepare(
              `SELECT
                 (SELECT count(*) FROM media) AS media,
                 (SELECT count(*) FROM saved) AS saved,
                 (SELECT count(*) FROM liked) AS liked,
                 (SELECT count(*) FROM saved_items_vec_local) AS saved_vec,
                 (SELECT count(*) FROM liked_items_vec_local) AS liked_vec`,
            )
            .get() as Record<string, number>
        ),
      ).toEqual({
        media: 1,
        saved: 1,
        liked: 1,
        saved_vec: 1,
        liked_vec: 1,
      });
    } finally {
      copied.close();
    }
  });
});
