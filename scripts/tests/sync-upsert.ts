import type { TestContext } from "./harness";

/** Resume-safe vec upserts (idempotent UNIQUE path). */
export async function runSyncUpsertResumeSuite(_ctx: TestContext) {
  console.log("[suite] sync-upsert/resume");
  const { getSqlite } = await import("../../src/lib/db");
  const { rebuildProviderIndex } = await import("../../src/lib/search/sync");
  const sqlite = getSqlite();

  // Partial local index + resume must keep existing rows and fill the rest.
  const localIds = (
    sqlite.prepare(`SELECT id FROM saved_items ORDER BY id`).all() as Array<{
      id: number;
    }>
  ).map((row) => row.id);
  if (localIds.length < 2) {
    throw new Error("Need at least 2 saved items for resume test");
  }
  await rebuildProviderIndex("saves", "local");
  const keepId = localIds[0]!;
  sqlite
    .prepare(`DELETE FROM saved_items_vec_local WHERE item_id != ?`)
    .run(BigInt(keepId));
  const beforeResume = (
    sqlite
      .prepare(`SELECT count(*) AS c FROM saved_items_vec_local`)
      .get() as { c: number }
  ).c;
  if (beforeResume !== 1) {
    throw new Error(`Expected 1 local vector before resume (got ${beforeResume})`);
  }
  await rebuildProviderIndex("saves", "local", { resume: true });
  const afterResume = (
    sqlite
      .prepare(`SELECT count(*) AS c FROM saved_items_vec_local`)
      .get() as { c: number }
  ).c;
  if (afterResume !== localIds.length) {
    throw new Error(
      `Resume should restore full local coverage (${localIds.length}, got ${afterResume})`,
    );
  }
  const kept = sqlite
    .prepare(`SELECT 1 AS ok FROM saved_items_vec_local WHERE item_id = ?`)
    .get(BigInt(keepId));
  if (!kept) {
    throw new Error("Resume must keep the already-embedded row");
  }

  // --- Resume chunk writes must be idempotent (UNIQUE constraint regression) ---
  const { writeEmbeddingChunk } = await import("../../src/lib/search/sync");
  const { embeddingConfigForProvider } = await import(
    "../../src/lib/search/embeddings"
  );
  const localDims = (await embeddingConfigForProvider("local")).profile.dimensions;
  const duplicateChunk = [
    { id: keepId, embedding: new Float32Array(localDims).fill(0.5) },
  ];
  const vecCountBefore = (
    sqlite
      .prepare(`SELECT count(*) AS c FROM saved_items_vec_local`)
      .get() as { c: number }
  ).c;
  // The resume path re-writes ids that may already exist (interrupted chunk,
  // stale skip set): it must not fail the job.
  writeEmbeddingChunk("saves", "local", duplicateChunk, "upsert", sqlite);
  writeEmbeddingChunk("saves", "local", duplicateChunk, "upsert", sqlite);
  const vecCountAfter = (
    sqlite
      .prepare(`SELECT count(*) AS c FROM saved_items_vec_local`)
      .get() as { c: number }
  ).c;
  if (vecCountAfter !== vecCountBefore) {
    throw new Error(
      `Idempotent chunk writes must not add rows (${vecCountBefore} -> ${vecCountAfter})`,
    );
  }
  let insertOnlyRejected = false;
  try {
    writeEmbeddingChunk("saves", "local", duplicateChunk, "insert-only", sqlite);
  } catch {
    insertOnlyRejected = true;
  }
  if (!insertOnlyRejected) {
    throw new Error(
      "insert-only writes should still conflict — the resume path must use upsert",
    );
  }
  // Resuming with a fully populated table must be a no-op, not a conflict.
  await rebuildProviderIndex("saves", "local", { resume: true });
  const vecCountAfterResume = (
    sqlite
      .prepare(`SELECT count(*) AS c FROM saved_items_vec_local`)
      .get() as { c: number }
  ).c;
  if (vecCountAfterResume !== localIds.length) {
    throw new Error(
      `Resume over a complete index should keep coverage (${localIds.length}, got ${vecCountAfterResume})`,
    );
  }

}

/** Chunked sync + API batching + resetLibrary wipe/preserve. */
export async function runSyncUpsertChunkedSuite(ctx: TestContext) {
  console.log("[suite] sync-upsert/chunked");
  const { getSqlite } = await import("../../src/lib/db");
  const { importExportJson } = await import("../../src/lib/import-export");
  const {
    getSettingsKeysStatus,
    updateSettingsKeys,
  } = await import("../../src/lib/settings/credentials");
  const { resetLibrary, RESET_LIBRARY_CONFIRMATION_PHRASE } = await import(
    "../../src/lib/settings/reset-library"
  );
  const sqlite = getSqlite();
  const files = ctx.files;

  // --- Chunked sync + API batching (synthetic; no real remote / prod DB) ---
  {
    const {
      EMBEDDING_SYNC_CHUNK_SIZE,
      rebuildProviderIndex,
    } = await import("../../src/lib/search/sync");
    const { EMBEDDING_API_BATCH_SIZE } = await import(
      "../../src/lib/search/embeddings"
    );
    if (EMBEDDING_SYNC_CHUNK_SIZE < 64 || EMBEDDING_SYNC_CHUNK_SIZE > 256) {
      throw new Error(
        `EMBEDDING_SYNC_CHUNK_SIZE should be 64–256 (got ${EMBEDDING_SYNC_CHUNK_SIZE})`,
      );
    }

    const importId = (
      sqlite
        .prepare(
          `INSERT INTO imports(filename, content_hash, status, items_added)
           VALUES ('synthetic-chunk-test.json', 'synth-chunk-hash', 'completed', 0)`,
        )
        .run().lastInsertRowid
    );
    const syntheticN = EMBEDDING_SYNC_CHUNK_SIZE * 2 + 17;
    const insertLike = sqlite.prepare(
      `INSERT INTO liked_items(
        media_key, href, shortcode, author_username, media_type, source,
        liked_at, first_seen_import_id, last_seen_import_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'post', 'liked_posts', unixepoch(), ?, ?, unixepoch(), unixepoch())`,
    );
    sqlite.transaction(() => {
      for (let i = 0; i < syntheticN; i += 1) {
        insertLike.run(
          `synth-like-${i}`,
          `https://www.instagram.com/p/syn${i}/`,
          `syn${i}`,
          `author_${i % 11}`,
          importId,
          importId,
        );
      }
    })();

    updateSettingsKeys({
      openaiEnabled: { saves: false, likes: true },
      voyageEnabled: false,
      ollamaEnabled: false,
      localEnabled: { saves: true, likes: true },
    });

    const requestsBeforeBatch = ctx.mockFetch.embeddingRequests;
    await rebuildProviderIndex("likes", "openai");
    const batchRequests = ctx.mockFetch.embeddingRequests - requestsBeforeBatch;
    const likesTotal = (
      sqlite.prepare(`SELECT count(*) AS c FROM liked_items`).get() as {
        c: number;
      }
    ).c;
    const expectedBatches = Math.ceil(likesTotal / EMBEDDING_API_BATCH_SIZE);
    if (batchRequests !== expectedBatches) {
      throw new Error(
        `OpenAI likes rebuild should batch: want ${expectedBatches} HTTP calls for ${likesTotal} rows, got ${batchRequests}`,
      );
    }
    const likesOpenAiCount = (
      sqlite
        .prepare(`SELECT count(*) AS c FROM liked_items_vec_openai`)
        .get() as { c: number }
    ).c;
    if (likesOpenAiCount !== likesTotal) {
      throw new Error(
        `Chunked likes openai rebuild should cover all ${likesTotal} rows (got ${likesOpenAiCount})`,
      );
    }

    await rebuildProviderIndex("likes", "local");
    const likesLocalCount = (
      sqlite
        .prepare(`SELECT count(*) AS c FROM liked_items_vec_local`)
        .get() as { c: number }
    ).c;
    if (likesLocalCount !== likesTotal) {
      throw new Error(
        `Chunked likes local rebuild should cover all ${likesTotal} rows (got ${likesLocalCount})`,
      );
    }

    updateSettingsKeys({
      openaiEnabled: true,
      voyageEnabled: true,
      ollamaEnabled: true,
      localEnabled: true,
    });
  }

  const settingsBeforeReset = getSettingsKeysStatus();
  const reset = resetLibrary(RESET_LIBRARY_CONFIRMATION_PHRASE, sqlite);
  if (!reset.ok || reset.wiped.savedItems < 1 || reset.wiped.imports < 1) {
    throw new Error("resetLibrary should wipe existing content rows");
  }
  if (typeof reset.wiped.likedItems !== "number") {
    throw new Error("resetLibrary should report likedItems wipe count");
  }

  const afterReset = sqlite
    .prepare(
      `SELECT
        (SELECT count(*) FROM saved_items) AS items,
        (SELECT count(*) FROM liked_items) AS likes,
        (SELECT count(*) FROM imports) AS imports,
        (SELECT count(*) FROM item_collections) AS collections,
        (SELECT count(*) FROM import_schemas) AS schemas,
        (SELECT count(*) FROM saved_items_fts) AS fts,
        (SELECT count(*) FROM liked_items_fts) AS likesFts,
        (SELECT count(*) FROM saved_items_vec_local) AS localVec,
        (SELECT count(*) FROM liked_items_vec_local) AS likesLocalVec,
        (SELECT count(*) FROM embedding_index_profiles) AS profiles,
        (SELECT count(*) FROM app_settings) AS settings`,
    )
    .get() as {
    items: number;
    likes: number;
    imports: number;
    collections: number;
    schemas: number;
    fts: number;
    likesFts: number;
    localVec: number;
    likesLocalVec: number;
    profiles: number;
    settings: number;
  };

  if (
    afterReset.items !== 0 ||
    afterReset.likes !== 0 ||
    afterReset.imports !== 0 ||
    afterReset.collections !== 0 ||
    afterReset.schemas !== 0 ||
    afterReset.fts !== 0 ||
    afterReset.likesFts !== 0 ||
    afterReset.localVec !== 0 ||
    afterReset.likesLocalVec !== 0 ||
    afterReset.profiles !== 0
  ) {
    throw new Error("resetLibrary must empty content and search indexes");
  }
  if (afterReset.settings < 1) {
    throw new Error("resetLibrary must keep app_settings");
  }

  const settingsAfterReset = getSettingsKeysStatus();
  if (
    settingsAfterReset.preferredProvider !==
      settingsBeforeReset.preferredProvider ||
    settingsAfterReset.openai.configured !==
      settingsBeforeReset.openai.configured ||
    settingsAfterReset.voyage.configured !==
      settingsBeforeReset.voyage.configured ||
    settingsAfterReset.openai.model !== settingsBeforeReset.openai.model
  ) {
    throw new Error("resetLibrary must keep settings and keyring secrets");
  }

  // Empty schemas must still accept a fresh import.
  const afterWipeImport = await importExportJson(
    files[0].content,
    "sample-saved-posts.json",
  );
  if (afterWipeImport.status !== "completed" || afterWipeImport.itemsAdded < 1) {
    throw new Error("Import after resetLibrary should succeed on empty schemas");
  }

}
