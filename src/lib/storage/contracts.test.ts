import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { normalizeEmbedding } from "../search/embeddings";
import { LibraryBusyError } from "../settings/library-busy";
import { RESET_LIBRARY_CONFIRMATION_PHRASE } from "../settings/reset-phrase";
import {
  clearStorageCache,
  createPostgresPool,
  createPostgresStorage,
  createSqliteStorage,
  ensureDatabaseSchema,
  installSqliteConnectionForTests,
} from "./index";
import type { Storage } from "./ports";

type ContractContext = {
  storage: Storage;
  cleanup: () => Promise<void>;
};

type ContractBackend = {
  name: string;
  engine: "sqlite" | "postgres";
  create: () => Promise<ContractContext>;
};

const POSTGRES_RESET_TABLES = [
  "media_embeddings",
  "saved_items_search",
  "liked_items_search",
  "import_schemas",
  "item_collections",
  "import_jobs",
  "embedding_jobs",
  "embedding_index_profiles",
  "saved",
  "liked",
  "media",
  "imports",
  "app_settings",
].join(", ");

function vector(...components: Array<[number, number]>): Float32Array {
  const value = new Float32Array(1024);
  for (const [index, component] of components) value[index] = component;
  return normalizeEmbedding(value);
}

async function seedCatalog(storage: Storage) {
  const imported = await storage.catalog.createImport({
    filename: "contract.json",
    contentHash: "contract-hash",
    status: "completed",
    itemsFound: 4,
    notes: "seed",
  });
  const saves = await storage.catalog.applyParsedItems(imported.id, [
    {
      mediaKey: "save-alpha",
      href: "https://www.instagram.com/p/Alpha/",
      shortcode: "Alpha",
      mediaType: "post",
      authorUsername: "alice",
      savedAt: new Date("2026-01-03T00:00:00.000Z"),
      collections: ["Recipes"],
    },
    {
      mediaKey: "save-beta",
      href: "https://www.instagram.com/reel/Beta/",
      shortcode: "Beta",
      mediaType: "reel",
      authorUsername: "bob",
      savedAt: new Date("2026-01-02T00:00:00.000Z"),
      collections: ["Travel"],
    },
    {
      mediaKey: "save-gamma",
      href: "https://www.instagram.com/p/Gamma/",
      shortcode: "Gamma",
      mediaType: "post",
      authorUsername: "carol",
      savedAt: new Date("2026-01-01T00:00:00.000Z"),
      collections: ["Recipes", "Travel"],
    },
  ]);
  const likes = await storage.catalog.applyLikedItems(imported.id, [
    {
      mediaKey: "save-alpha",
      href: "https://www.instagram.com/p/Alpha/",
      shortcode: "Alpha",
      mediaType: "post",
      authorUsername: "alice",
      likedAt: new Date("2026-01-04T00:00:00.000Z"),
      source: "liked_posts",
    },
  ]);
  return {
    importId: imported.id,
    saveIds: saves.changedIds,
    likeIds: likes.changedIds,
  };
}

function registerStorageContracts(backend: ContractBackend) {
  describe.sequential(`storage contracts (${backend.name})`, () => {
    let context: ContractContext;

    beforeEach(async () => {
      context = await backend.create();
    });

    afterEach(async () => {
      await context.cleanup();
    });

    it("catalog: persists import-adjacent writes, browse filters, and rollback", async () => {
      const { storage } = context;
      const seeded = await seedCatalog(storage);

      await storage.catalog.appendImportNotes(seeded.importId, "contract note");
      await storage.catalog.updateImport(seeded.importId, {
        itemsAdded: 3,
        itemsUpdated: 0,
        itemsSkipped: 0,
      });

      const stats = await storage.catalog.getStats();
      expect(stats).toMatchObject({
        totalItems: 3,
        totalLikes: 1,
        importCount: 1,
      });
      expect(await storage.catalog.findCompletedImportByHash("contract-hash")).toEqual({
        id: seeded.importId,
      });

      const saves = await storage.catalog.listSaves({
        page: 1,
        pageSize: 10,
        collection: "Recipes",
      });
      expect(saves.items.map((item) => item.mediaKey)).toEqual([
        "save-alpha",
        "save-gamma",
      ]);
      expect(saves.items[0]?.membership).toEqual({
        saved: true,
        liked: true,
      });
      expect(await storage.catalog.listSavesFilterOptions()).toEqual({
        authors: ["alice", "bob", "carol"],
        collections: ["Recipes", "Travel"],
      });

      const likes = await storage.catalog.listLikes({
        page: 1,
        pageSize: 10,
        author: "alice",
      });
      expect(likes.items).toHaveLength(1);
      expect(likes.items[0]?.mediaKey).toBe("save-alpha");
      expect(likes.items[0]?.membership).toEqual({ saved: true, liked: true });

      const overlappingSaves = await storage.catalog.listSaves({
        page: 1,
        pageSize: 10,
        membership: "both",
      });
      const overlappingLikes = await storage.catalog.listLikes({
        page: 1,
        pageSize: 10,
        membership: "both",
      });
      expect(overlappingSaves.total).toBe(1);
      expect(overlappingSaves.items.map((item) => item.mediaKey)).toEqual([
        "save-alpha",
      ]);
      expect(overlappingLikes.total).toBe(1);
      expect(overlappingLikes.items.map((item) => item.mediaKey)).toEqual([
        "save-alpha",
      ]);

      expect(await storage.catalog.countPersistedImportRows(seeded.importId)).toEqual({
        itemsAdded: 3,
        itemsUpdated: 0,
        likesAdded: 1,
        likesUpdated: 0,
      });
      const rolledBack = await storage.catalog.rollbackImportInserts(seeded.importId);
      expect(rolledBack).toMatchObject({
        savesDeleted: 3,
        likesDeleted: 1,
      });
      expect((await storage.catalog.getStats()).totalItems).toBe(0);
    });

    it("search: keeps FTS and normalized vector ranking equivalent", async () => {
      const { storage } = context;
      const { saveIds } = await seedCatalog(storage);
      expect(saveIds).toHaveLength(3);

      await storage.search.upsertItemFts(saveIds[0]!, {
        authorUsername: "alice",
        shortcode: "Alpha",
        mediaKey: "save-alpha",
        mediaType: "post",
        collections: ["Recipes"],
      });
      const fts = await storage.search.searchFts("saves", "alice", 10);
      expect(fts.degraded).toBe(false);
      expect(fts.hits.map((hit) => hit.id)).toContain(saveIds[0]);

      await storage.search.recreateVectorTable("saves", "local", 1024);
      await storage.search.writeEmbeddingProfile("saves", "local", {
        provider: "local",
        model: "contract-1024",
        dimensions: 1024,
        endpoint: null,
      });
      await storage.search.writeEmbeddingChunk(
        "saves",
        "local",
        [
          { id: saveIds[0]!, embedding: vector([0, 1]) },
          { id: saveIds[1]!, embedding: vector([0, 0.8], [1, 0.6]) },
          { id: saveIds[2]!, embedding: vector([1, 1]) },
        ],
        "upsert",
      );

      const hits = await storage.search.searchVector(
        "saves",
        "local",
        vector([0, 1]),
        3,
      );
      expect(hits.map((hit) => hit.id)).toEqual(saveIds);
      expect(hits[0]?.distance).toBeCloseTo(0, 5);
      expect(hits[1]!.distance).toBeLessThan(hits[2]!.distance);
      expect(await storage.search.vecCount("saves", "local")).toBe(3);
      expect(
        await storage.search.existingEmbeddingItemIds("saves", "local"),
      ).toEqual(new Set(saveIds));
      expect(
        await storage.search.getIndexedEmbeddingProfile("saves", "local"),
      ).toEqual({
        provider: "local",
        model: "contract-1024",
        dimensions: 1024,
        endpoint: null,
      });

      await storage.search.recreateVectorTable("likes", "local", 1024);
      await storage.search.writeEmbeddingProfile("likes", "local", {
        provider: "local",
        model: "contract-1024",
        dimensions: 1024,
        endpoint: null,
      });
      expect(
        await storage.search.projectExistingEmbeddings(
          "likes",
          "local",
          [saveIds[0]!],
        ),
      ).toEqual(new Set([saveIds[0]]));
      expect(await storage.search.vecCount("likes", "local")).toBe(1);
      const projectedHits = await storage.search.searchVector(
        "likes",
        "local",
        vector([0, 1]),
        1,
      );
      expect(projectedHits[0]?.id).toBe(saveIds[0]);
      expect(projectedHits[0]?.distance).toBeCloseTo(0, 5);

      const integrity = await storage.search.assessVectorIntegrity(
        "saves",
        "local",
      );
      expect(integrity.ok).toBe(true);
      expect(integrity.orphanVecRows).toBe(0);
    });

    it("jobs: preserves embedding and import lifecycle semantics", async () => {
      const { jobs } = context.storage;
      const embedding = await jobs.createEmbeddingJob({
        target: "local",
        total: 3,
        message: "queued",
      });
      expect(embedding).toMatchObject({
        state: "pending",
        phase: "queued",
        processed: 0,
        total: 3,
      });
      expect(await jobs.hasOpenEmbeddingJobForTarget("local")).toBe(true);

      await jobs.updateEmbeddingJob(embedding.id, {
        state: "running",
        phase: "embedding",
        processed: 2,
        currentProvider: "local",
        message: "working",
      });
      expect(await jobs.getActiveEmbeddingJob()).toMatchObject({
        id: embedding.id,
        state: "running",
        processed: 2,
      });
      await jobs.updateEmbeddingJob(embedding.id, {
        state: "completed",
        phase: "done",
        processed: 3,
        finished: true,
      });
      expect(await jobs.getLatestFinishedEmbeddingJob()).toMatchObject({
        id: embedding.id,
        state: "completed",
        percent: 100,
      });
      expect(await jobs.hasOpenEmbeddingJobForTarget("local")).toBe(false);

      const importJob = await jobs.createImportJob({
        filename: "contract.json",
        contentHash: "job-hash",
        spoolPath: "/tmp/instagram-saves-contract-missing.json",
        kind: "json",
        message: "queued",
      });
      expect((await jobs.getPendingImportJobs()).map((job) => job.id)).toEqual([
        importJob.id,
      ]);
      await jobs.updateImportJob(importJob.id, {
        state: "running",
        phase: "writing",
        processed: 1,
        total: 2,
      });
      expect(await jobs.getActiveImportJob()).toMatchObject({
        id: importJob.id,
        state: "running",
        percent: 50,
      });
      await jobs.updateImportJob(importJob.id, {
        state: "completed",
        phase: "completed",
        processed: 2,
        total: 2,
        finished: true,
      });
      const status = await jobs.getImportJobsStatus();
      expect(status.job).toBeNull();
      expect(status.pendingJobs).toEqual([]);
      expect(status.recentJobs?.[0]).toMatchObject({
        id: importJob.id,
        state: "completed",
        percent: 100,
      });
    });

    it("settings: round-trips normalized values and provider enables", async () => {
      const { settings } = context.storage;
      await settings.setAppSetting("embedding_timeout_ms", " 12345 ");
      expect(await settings.getAppSetting("embedding_timeout_ms")).toBe("12345");
      expect(await settings.getEmbeddingTimeoutMs()).toBe(12345);

      await settings.setProviderLibraryEnabled("openai", "likes", true);
      expect(await settings.isProviderIndexEnabled("openai", "likes")).toBe(true);
      expect(await settings.getProviderLibraryEnables("openai")).toEqual({
        saves: false,
        likes: true,
      });

      await settings.setAppSetting("embedding_provider", "openai");
      expect(await settings.getPreferredEmbeddingProvider()).toBe("openai");
      await settings.setAppSetting("embedding_provider", null);
      expect(await settings.getAppSetting("embedding_provider")).toBeNull();
    });

    it("maintenance: reports capabilities, busy state, integrity, and reset", async () => {
      const { storage } = context;
      expect(await storage.maintenance.engineInfo()).toMatchObject({
        engine: backend.engine,
        supportsVacuum: true,
      });
      expect((await storage.maintenance.checkIntegrity()).ok).toBe(true);

      const job = await storage.jobs.createEmbeddingJob({
        target: "local",
        total: 1,
        message: "queued",
      });
      const busy = await storage.maintenance.getLibraryBusyState("reset library");
      expect(busy.busy).toBe(true);
      await expect(
        storage.maintenance.resetLibrary(RESET_LIBRARY_CONFIRMATION_PHRASE),
      ).rejects.toBeInstanceOf(LibraryBusyError);

      await storage.jobs.updateEmbeddingJob(job.id, {
        state: "completed",
        phase: "done",
        processed: 1,
        finished: true,
      });
      await seedCatalog(storage);
      const reset = await storage.maintenance.resetLibrary(
        RESET_LIBRARY_CONFIRMATION_PHRASE,
      );
      expect(reset.ok).toBe(true);
      expect((await storage.catalog.getStats()).totalItems).toBe(0);
      expect((await storage.maintenance.checkIntegrity()).ok).toBe(true);
    });
  });
}

const sqliteBackend: ContractBackend = {
  name: "SQLite",
  engine: "sqlite",
  create: async () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqliteVec.load(sqlite);
    ensureDatabaseSchema(sqlite);
    installSqliteConnectionForTests(sqlite);
    clearStorageCache();
    return {
      storage: createSqliteStorage(sqlite),
      cleanup: async () => {
        clearStorageCache();
        if (sqlite.open) sqlite.close();
      },
    };
  },
};

registerStorageContracts(sqliteBackend);

const postgresUrl = process.env.INSTAGRAM_SAVES_DATABASE_URL?.trim();
let postgresPool: Pool | null = null;
let postgresSkipReason =
  "INSTAGRAM_SAVES_DATABASE_URL is not set; skipping PostgreSQL storage contracts.";

if (postgresUrl) {
  try {
    postgresPool = await createPostgresPool(postgresUrl);
  } catch (error) {
    postgresSkipReason =
      "PostgreSQL is unavailable; skipping storage contracts: " +
      (error instanceof Error ? error.message : String(error));
  }
}

if (!postgresPool) {
  if (process.env.CI === "true" && postgresUrl) {
    throw new Error(
      `[storage-contracts] PostgreSQL is required in CI when INSTAGRAM_SAVES_DATABASE_URL is set: ${postgresSkipReason}`,
    );
  }
  console.info(`[storage-contracts] ${postgresSkipReason}`);
  describe.skip("storage contracts (PostgreSQL unavailable)", () => {
    it(postgresSkipReason, () => undefined);
  });
} else {
  const pool = postgresPool;
  registerStorageContracts({
    name: "PostgreSQL",
    engine: "postgres",
    create: async () => {
      await pool.query(`TRUNCATE TABLE ${POSTGRES_RESET_TABLES} RESTART IDENTITY CASCADE`);
      return {
        storage: createPostgresStorage(pool),
        cleanup: async () => {
          await pool.query(
            `TRUNCATE TABLE ${POSTGRES_RESET_TABLES} RESTART IDENTITY CASCADE`,
          );
        },
      };
    },
  });
  afterAll(async () => {
    await pool.end();
  });
}
