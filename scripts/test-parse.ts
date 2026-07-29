import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
  const tmpDb = path.join(
    os.tmpdir(),
    `instagram-saves-test-${Date.now()}.db`,
  );
  process.env.INSTAGRAM_SAVES_DB = tmpDb;
  process.env.INSTAGRAM_SAVES_KEYRING = "memory";
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_API_KEY;
  delete process.env.EMBEDDING_OLLAMA;
  delete process.env.OLLAMA_ENABLED;
  delete process.env.OPENAI_ENABLED;
  delete process.env.VOYAGE_ENABLED;
  delete process.env.LOCAL_ENABLED;
  delete process.env.OLLAMA_EMBEDDING_MODEL;
  delete process.env.EMBEDDING_BASE_URL;
  delete process.env.EMBEDDING_MODEL;
  delete process.env.VOYAGE_MODEL;
  delete process.env.EMBEDDING_TIMEOUT_MS;

  const { parseExportJsonFiles } = await import("../src/lib/parse-export");
  const { importExportJson } = await import("../src/lib/import-export");
  const { listSaves } = await import("../src/lib/queries");
  const { rebuildSearchIndex } = await import("../src/lib/search/sync");
  const { getProviderAvailability } = await import(
    "../src/lib/search/providers"
  );
  const { getSqlite } = await import("../src/lib/db");
  const {
    getSettingsKeysStatus,
    updateSettingsKeys,
  } = await import("../src/lib/settings/credentials");
  const { resetKeyringForTests } = await import("../src/lib/settings/keyring");

  resetKeyringForTests();

  const fixtures = path.join(process.cwd(), "fixtures");

  const files = [
    {
      name: "your_instagram_activity/saved/saved_posts.json",
      content: fs.readFileSync(
        path.join(fixtures, "sample-saved-posts.json"),
        "utf8",
      ),
    },
    {
      name: "your_instagram_activity/saved/saved_collections.json",
      content: fs.readFileSync(
        path.join(fixtures, "sample-saved-collections.json"),
        "utf8",
      ),
    },
  ];

  const parsed = parseExportJsonFiles(files);
  console.log("parsed count:", parsed.items.length);
  console.log(
    parsed.items.map((item) => ({
      key: item.mediaKey,
      type: item.mediaType,
      author: item.authorUsername,
      collections: item.collections,
    })),
  );

  const newFormat = parseExportJsonFiles([
    {
      name: "your_instagram_activity/saved/saved_posts.json",
      content: fs.readFileSync(
        path.join(fixtures, "sample-saved-posts-new-format.json"),
        "utf8",
      ),
    },
  ]);
  const newAuthor = newFormat.items.find(
    (item) => item.mediaKey === "newfmtreel01",
  );
  if (!newAuthor?.authorUsername || !newAuthor.savedAt) {
    throw new Error("New-format saved posts should parse author and savedAt");
  }

  const flatCollections = parseExportJsonFiles([
    {
      name: "your_instagram_activity/saved/saved_collections.json",
      content: fs.readFileSync(
        path.join(fixtures, "sample-saved-collections-flat.json"),
        "utf8",
      ),
    },
  ]);
  const flatItem = flatCollections.items.find(
    (item) => item.mediaKey === "flatcollreel1",
  );
  if (
    !flatItem?.authorUsername ||
    !flatItem.collections.includes("Recipes") ||
    !flatItem.savedAt
  ) {
    throw new Error("Flat collections format should parse author, date, and tag");
  }

  const first = await importExportJson(
    files[0].content,
    "sample-saved-posts.json",
  );
  console.log("first import:", first);

  const second = await importExportJson(
    files[0].content,
    "sample-saved-posts.json",
  );
  console.log("duplicate import:", second);

  const merged = await importExportJson(
    files[1].content,
    "sample-saved-collections.json",
  );
  console.log("collections import:", merged);

  if (parsed.items.length < 3) {
    throw new Error(`Expected at least 3 unique items, got ${parsed.items.length}`);
  }
  if (first.status !== "completed" || first.itemsAdded < 1) {
    throw new Error("First import should add items");
  }
  if (second.status !== "duplicate") {
    throw new Error("Second identical import should be duplicate");
  }
  if (merged.status !== "completed") {
    throw new Error("Collections import should complete");
  }
  const sqlite = getSqlite();

  const {
    catalogSchemasFromFiles,
    inferSchemaFromValue,
    parseJsonPrefix,
  } = await import("../src/lib/json-schema-infer");
  const { getSchemasForImport, getAggregatedSchemas } = await import(
    "../src/lib/schema-catalog"
  );

  const inferred = catalogSchemasFromFiles([
    { name: files[0].name, content: files[0].content },
  ]);
  if (inferred.length !== 1 || inferred[0]?.topLevelType !== "object") {
    throw new Error("Schema inference should see object top-level for saved posts");
  }
  const mediaKey = inferred[0]?.schema?.keys?.saved_saved_media;
  if (!mediaKey || mediaKey.type !== "array" || !mediaKey.items) {
    throw new Error("Schema should describe saved_saved_media as an array of objects");
  }

  const truncated = parseJsonPrefix(
    '{"items":[{"a":1},{"a":2},{"a":',
    true,
  ) as { items: unknown[] };
  if (!Array.isArray(truncated.items) || truncated.items.length < 2) {
    throw new Error("Truncated JSON repair should keep complete array elements");
  }
  const deep = inferSchemaFromValue({ a: { b: { c: [1, 2, 3] } } });
  if (deep.keys?.a?.keys?.b?.keys?.c?.type !== "array") {
    throw new Error("Nested schema inference should reach array under a.b.c");
  }

  if (!first.importId) {
    throw new Error("First import should return an importId for schema checks");
  }
  const firstSchemas = getSchemasForImport(first.importId);
  if (firstSchemas.length < 1) {
    throw new Error("Import should persist at least one import_schemas row");
  }
  if (firstSchemas[0]?.topLevelType !== "object" || !firstSchemas[0]?.schema) {
    throw new Error("Persisted schema should include top-level object shape");
  }
  const schemaTableCount = (
    sqlite
      .prepare("SELECT count(*) AS count FROM import_schemas")
      .get() as { count: number }
  ).count;
  if (schemaTableCount < 2) {
    throw new Error(
      `Expected schemas from multiple imports, got ${schemaTableCount}`,
    );
  }
  const aggregated = getAggregatedSchemas();
  if (aggregated.length < 1) {
    throw new Error("Aggregated schema catalog should list unique paths");
  }

  const localCount = (
    sqlite
      .prepare("SELECT count(*) AS count FROM saved_items_vec_local")
      .get() as { count: number }
  ).count;
  if (localCount !== 3) {
    throw new Error(`Expected 3 offline vectors after imports, got ${localCount}`);
  }

  const availabilityLocal = getProviderAvailability();
  if (
    availabilityLocal.available.join(",") !== "local" ||
    availabilityLocal.default !== "local"
  ) {
    throw new Error("Without API keys only local should be available");
  }

  const settingsBefore = getSettingsKeysStatus();
  if (
    !settingsBefore.keyring.available ||
    settingsBefore.keyring.backend !== "memory" ||
    settingsBefore.openai.configured ||
    settingsBefore.voyage.configured
  ) {
    throw new Error("Memory keyring should start empty for cloud keys");
  }

  updateSettingsKeys({
    openaiApiKey: "test-key",
    voyageApiKey: "test-voyage-key",
    ollamaBaseUrl: "http://127.0.0.1:11434/v1",
    ollamaModel: "qwen3-embedding:0.6b",
    openaiBaseUrl: "https://api.openai.com/v1",
    openaiModel: "text-embedding-3-small",
    voyageModel: "voyage-4-lite",
    preferredProvider: "openai",
    timeoutMs: 10000,
  });

  const settingsAfterKeys = getSettingsKeysStatus();
  if (
    !settingsAfterKeys.openai.configured ||
    settingsAfterKeys.openai.source !== "keyring" ||
    !settingsAfterKeys.voyage.configured ||
    settingsAfterKeys.openai.enabled ||
    settingsAfterKeys.voyage.enabled ||
    settingsAfterKeys.ollama.enabled ||
    settingsAfterKeys.ollama.available ||
    !settingsAfterKeys.local.enabled ||
    settingsAfterKeys.ollama.model !== "qwen3-embedding:0.6b" ||
    settingsAfterKeys.openai.model !== "text-embedding-3-small" ||
    settingsAfterKeys.voyage.model !== "voyage-4-lite" ||
    settingsAfterKeys.preferredProvider !== "openai" ||
    settingsAfterKeys.timeoutMs !== 10000
  ) {
    throw new Error(
      "Settings should persist keys without enabling indexes; local defaults on",
    );
  }
  if (JSON.stringify(settingsAfterKeys).includes("test-key")) {
    throw new Error("Settings status must never echo secret values");
  }

  const availabilityKeysOnly = getProviderAvailability();
  if (
    availabilityKeysOnly.available.join(",") !== "local" ||
    availabilityKeysOnly.configured.openai ||
    availabilityKeysOnly.configured.voyage ||
    availabilityKeysOnly.configured.ollama
  ) {
    throw new Error(
      `API keys / Ollama URL alone must not enable indexes (got ${availabilityKeysOnly.available.join(",")})`,
    );
  }

  updateSettingsKeys({
    localEnabled: true,
    openaiEnabled: true,
    voyageEnabled: true,
    ollamaEnabled: true,
  });

  const settingsAfter = getSettingsKeysStatus();
  if (
    !settingsAfter.openai.enabled ||
    !settingsAfter.voyage.enabled ||
    !settingsAfter.ollama.enabled ||
    !settingsAfter.ollama.available ||
    !settingsAfter.local.enabled
  ) {
    throw new Error("Explicit enable flags should turn indexes on");
  }

  // Models come from Settings (sqlite), not env.
  delete process.env.EMBEDDING_MODEL;
  delete process.env.VOYAGE_MODEL;

  const availabilityAll = getProviderAvailability();
  if (
    availabilityAll.available.join(",") !== "local,ollama,openai,voyage" ||
    availabilityAll.default !== "openai"
  ) {
    throw new Error(
      `Expected local,ollama,openai,voyage (got ${availabilityAll.available.join(",")})`,
    );
  }

  let embeddingRequests = 0;
  let failEmbeddingRequests = false;
  const embeddingBodies: Array<Record<string, unknown>> = [];
  const embeddingUrls: string[] = [];
  globalThis.fetch = async (input, init) => {
    embeddingRequests += 1;
    embeddingUrls.push(String(input));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    embeddingBodies.push(body);
    if (failEmbeddingRequests) throw new Error("mock network unavailable");
    const dimensions =
      typeof body.output_dimension === "number"
        ? body.output_dimension
        : Number(body.dimensions);
    return Response.json({
      data: [
        {
          embedding: Array.from({ length: dimensions }, (_, i) => (i ? 0 : 1)),
        },
      ],
    });
  };

  const mismatchSearch = await listSaves({
    q: "chef.daily",
    provider: "openai",
  });
  if (
    mismatchSearch.searchMode !== "hybrid-local-fallback" ||
    mismatchSearch.providerFallback !== true ||
    embeddingRequests !== 0
  ) {
    throw new Error("Provider mismatch must use the offline semantic fallback");
  }

  await rebuildSearchIndex({ requireRemote: true });
  const openAiCount = (
    sqlite
      .prepare("SELECT count(*) AS count FROM saved_items_vec_openai")
      .get() as { count: number }
  ).count;
  const voyageCount = (
    sqlite
      .prepare("SELECT count(*) AS count FROM saved_items_vec_voyage")
      .get() as { count: number }
  ).count;
  const ollamaCount = (
    sqlite
      .prepare("SELECT count(*) AS count FROM saved_items_vec_ollama")
      .get() as { count: number }
  ).count;
  if (openAiCount !== 3 || voyageCount !== 3 || ollamaCount !== 3) {
    throw new Error("Reindex should cover openai, voyage, and ollama indexes");
  }

  const remoteSearch = await listSaves({
    q: "chef.daily",
    provider: "openai",
  });
  if (
    !["hybrid", "vec"].includes(remoteSearch.searchMode) ||
    remoteSearch.searchProvider !== "openai" ||
    embeddingRequests < 1
  ) {
    throw new Error("OpenAI index and query should use the mock OpenAI path");
  }

  const ollamaSearch = await listSaves({
    q: "chef.daily",
    provider: "ollama",
  });
  const ollamaQueryUrl = embeddingUrls.at(-1);
  const ollamaQueryBody = embeddingBodies.at(-1);
  if (
    !["hybrid", "vec"].includes(ollamaSearch.searchMode ?? "") ||
    ollamaSearch.searchProvider !== "ollama" ||
    ollamaQueryUrl !== "http://127.0.0.1:11434/v1/embeddings" ||
    ollamaQueryBody?.dimensions !== 1024 ||
    ollamaQueryBody?.model !== "qwen3-embedding:0.6b"
  ) {
    throw new Error("Ollama search should hit OpenAI-compatible embeddings API");
  }

  const requestsBeforeFailure = embeddingRequests;
  failEmbeddingRequests = true;
  const offlineFallbackSearch = await listSaves({
    q: "chef.daily",
    provider: "openai",
  });
  failEmbeddingRequests = false;
  if (
    offlineFallbackSearch.searchMode !== "hybrid-local-fallback" ||
    offlineFallbackSearch.searchProvider !== "local" ||
    offlineFallbackSearch.providerFallback !== true ||
    embeddingRequests !== requestsBeforeFailure + 1
  ) {
    throw new Error("Remote query failure must fall back to local vectors");
  }

  const requestsBeforeRemoteImport = embeddingRequests;
  const remoteImport = await importExportJson(
    files[0].content.replace("AbCdEfGhIjK", "OpenAITst12"),
    "saved_posts_openai.json",
  );
  console.log("OpenAI+Voyage+Ollama import:", remoteImport);
  if (
    remoteImport.status !== "completed" ||
    embeddingRequests !== requestsBeforeRemoteImport + 3 ||
    !remoteImport.message.includes("openai") ||
    !remoteImport.message.includes("voyage") ||
    !remoteImport.message.includes("ollama")
  ) {
    throw new Error("Changed imports should update ollama, openai, and voyage");
  }
  const vectorCounts = sqlite
    .prepare(
      `SELECT
        (SELECT count(*) FROM saved_items_vec_local) AS localCount,
        (SELECT count(*) FROM saved_items_vec_ollama) AS ollamaCount,
        (SELECT count(*) FROM saved_items_vec_openai) AS openAiCount,
        (SELECT count(*) FROM saved_items_vec_voyage) AS voyageCount`,
    )
    .get() as {
    localCount: number;
    ollamaCount: number;
    openAiCount: number;
    voyageCount: number;
  };
  if (
    vectorCounts.localCount !== 4 ||
    vectorCounts.ollamaCount !== 4 ||
    vectorCounts.openAiCount !== 4 ||
    vectorCounts.voyageCount !== 4
  ) {
    throw new Error("Imports must update all four vector indexes");
  }
  const allowedEndpoints = new Set([
    "https://api.openai.com/v1/embeddings",
    "https://api.voyageai.com/v1/embeddings",
    "http://127.0.0.1:11434/v1/embeddings",
  ]);
  if (embeddingUrls.some((url) => !allowedEndpoints.has(url))) {
    throw new Error("Unexpected embedding endpoint in mock requests");
  }

  const voyageSearch = await listSaves({
    q: "chef.daily",
    provider: "voyage",
  });
  const voyageQueryBody = embeddingBodies.at(-1);
  if (
    !["hybrid", "vec"].includes(voyageSearch.searchMode ?? "") ||
    voyageSearch.searchProvider !== "voyage" ||
    voyageQueryBody?.input_type !== "query" ||
    voyageQueryBody?.output_dimension !== 1024
  ) {
    throw new Error(
      "Voyage search should use native endpoint, 1024 dims, and query input_type",
    );
  }

  updateSettingsKeys({ openaiApiKey: "", openaiEnabled: false });
  const forcedFallback = await listSaves({
    q: "chef.daily",
    provider: "openai",
  });
  if (
    forcedFallback.searchProvider !== "local" ||
    forcedFallback.providerFallback !== true ||
    !forcedFallback.providerFallbackReason
  ) {
    throw new Error("Unconfigured provider request must fall back to local");
  }

  // Env key alone must not enable; explicit enable + env key does.
  process.env.OPENAI_API_KEY = "env-fallback-key";
  const envKeyOnly = getProviderAvailability();
  if (envKeyOnly.configured.openai) {
    throw new Error("OPENAI_API_KEY alone must not enable openai");
  }
  updateSettingsKeys({ openaiEnabled: true });
  const envAvailability = getProviderAvailability();
  if (!envAvailability.configured.openai) {
    throw new Error("Enabled OpenAI with OPENAI_API_KEY env fallback should work");
  }
  delete process.env.OPENAI_API_KEY;
  updateSettingsKeys({ openaiEnabled: false });

  // --- Indexes status + background reindex jobs ---
  updateSettingsKeys({
    openaiApiKey: "test-openai-key",
    voyageApiKey: "test-voyage-key",
    openaiEnabled: true,
    voyageEnabled: true,
    ollamaEnabled: true,
    localEnabled: true,
  });
  const { getSearchIndexStatus } = await import("../src/lib/search/status");
  const {
    startReindexJob,
    waitForIdleJob,
    cancelReindexJob,
    getLatestEmbeddingJob,
    getPendingEmbeddingJobs,
    getActiveEmbeddingJob,
  } = await import("../src/lib/search/jobs");

  const statusBefore = getSearchIndexStatus();
  if (statusBefore.providers.length !== 4) {
    throw new Error("Status should include all four embedding providers");
  }
  if (!Array.isArray(statusBefore.pendingJobs) || !Array.isArray(statusBefore.recentJobs)) {
    throw new Error("Status should include pendingJobs and recentJobs arrays");
  }
  const localStatus = statusBefore.providers.find((p) => p.provider === "local");
  if (!localStatus?.configured || localStatus.health === "unavailable") {
    throw new Error("Local provider should be enabled by default / for status test");
  }
  const openaiStatus = statusBefore.providers.find((p) => p.provider === "openai");
  if (!openaiStatus?.configured || !openaiStatus.enabled) {
    throw new Error("OpenAI should be enabled and credentialed for status test");
  }
  updateSettingsKeys({ openaiEnabled: false });
  const disabledOpenAi = getSearchIndexStatus().providers.find(
    (p) => p.provider === "openai",
  );
  if (
    disabledOpenAi?.configured ||
    disabledOpenAi?.enabled ||
    !disabledOpenAi?.hasCredentials ||
    disabledOpenAi.health !== "unavailable"
  ) {
    throw new Error(
      "Disabled OpenAI with saved credentials should report credentials + unavailable",
    );
  }
  updateSettingsKeys({ openaiEnabled: true });

  // Clear openai vectors to simulate a newly enabled / empty index.
  sqlite.exec(`DELETE FROM saved_items_vec_openai`);
  sqlite
    .prepare(`DELETE FROM embedding_index_profiles WHERE index_name = 'openai'`)
    .run();
  const emptyOpenAi = getSearchIndexStatus().providers.find(
    (p) => p.provider === "openai",
  );
  if (emptyOpenAi?.health !== "empty" || emptyOpenAi.embeddedCount !== 0) {
    throw new Error("Cleared openai index should report empty coverage");
  }

  const started = startReindexJob("openai");
  if (!started.ok) {
    throw new Error(`Failed to start openai reindex: ${started.error}`);
  }
  if (started.job.state !== "running" || started.job.target !== "openai") {
    throw new Error("Started openai job should be running");
  }
  // Different provider should enqueue behind the active job (not 409).
  const queued = startReindexJob("local");
  if (!queued.ok) {
    throw new Error(`Local reindex should enqueue while openai runs: ${queued.error}`);
  }
  if (queued.job.state !== "pending" && getPendingEmbeddingJobs().length < 1) {
    throw new Error("Local job should be pending in the queue");
  }
  const duplicate = startReindexJob("local");
  if (duplicate.ok || duplicate.status !== 409) {
    throw new Error("Duplicate local job should be rejected with 409");
  }

  const finished = await waitForIdleJob(60_000);
  if (!finished || finished.state !== "completed") {
    throw new Error(
      `Queue should finish with a completed job (got ${finished?.state}: ${finished?.error})`,
    );
  }
  const openaiAfter = getSearchIndexStatus().providers.find(
    (p) => p.provider === "openai",
  );
  if (
    openaiAfter?.health !== "ready" ||
    openaiAfter.embeddedCount !== statusBefore.totalItems
  ) {
    throw new Error("OpenAI reindex via job should restore full coverage");
  }

  // all-configured expands to one job per enabled provider.
  const allJobs = startReindexJob("all-configured");
  if (!allJobs.ok) {
    throw new Error(`Failed to start all-configured reindex: ${allJobs.error}`);
  }
  if (allJobs.jobs.length < 2) {
    throw new Error(
      `all-configured should enqueue multiple provider jobs (got ${allJobs.jobs.length})`,
    );
  }
  if (allJobs.jobs.some((job) => job.target === "all-configured")) {
    throw new Error("Expanded jobs must use concrete provider targets");
  }
  const activeAfterAll = getActiveEmbeddingJob();
  if (!activeAfterAll || activeAfterAll.state !== "running") {
    throw new Error("First all-configured provider job should be running");
  }
  if (getPendingEmbeddingJobs().length < 1) {
    throw new Error("Remaining all-configured providers should be pending");
  }

  // Cancel active only; queued jobs remain and continue.
  const cancelled = cancelReindexJob(activeAfterAll.id);
  if (!cancelled.ok) {
    throw new Error(`Cancel should succeed: ${cancelled.error}`);
  }
  const afterCancelSettle = await new Promise<{
    state: string;
    id: number;
  } | null>((resolve) => {
    const startedAt = Date.now();
    const tick = () => {
      // Wait until the cancelled job is terminal (next may already be running).
      const cancelledRow = sqlite
        .prepare(`SELECT id, state FROM embedding_jobs WHERE id = ?`)
        .get(activeAfterAll.id) as { id: number; state: string } | undefined;
      if (cancelledRow?.state === "cancelled") {
        resolve(cancelledRow);
        return;
      }
      if (Date.now() - startedAt > 60_000) {
        resolve(null);
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
  if (!afterCancelSettle || afterCancelSettle.state !== "cancelled") {
    throw new Error(
      `Cancelled active job should end as cancelled (got ${afterCancelSettle?.state})`,
    );
  }

  // Let the remaining queue drain so later tests see a clean runner.
  await waitForIdleJob(120_000);
  if (getLatestEmbeddingJob() == null) {
    throw new Error("Expected embedding jobs after all-configured queue");
  }

  const { resetLibrary, RESET_LIBRARY_CONFIRMATION_PHRASE } = await import(
    "../src/lib/settings/reset-library"
  );

  const backfillContent = JSON.stringify({
    saved_saved_media: [
      {
        title: "",
        string_list_data: [
          {
            href: "https://www.instagram.com/reel/BackfillReel1/",
            value: "backfill.user",
            timestamp: 1700000000,
          },
        ],
      },
    ],
  });
  const backfillFirst = await importExportJson(
    backfillContent,
    "backfill-saved.json",
  );
  if (backfillFirst.status !== "completed" || backfillFirst.itemsAdded !== 1) {
    throw new Error("Backfill fixture should import one item");
  }
  sqlite
    .prepare(
      "UPDATE saved_items SET author_username = NULL, saved_at = NULL WHERE media_key = ?",
    )
    .run("backfillreel1");
  const backfillAgain = await importExportJson(
    backfillContent,
    "backfill-saved.json",
  );
  if (
    backfillAgain.status !== "duplicate" ||
    backfillAgain.itemsUpdated !== 1
  ) {
    throw new Error(
      "Duplicate re-import should backfill missing author/savedAt metadata",
    );
  }

  let rejectedBadPhrase = false;
  try {
    resetLibrary("wrong phrase");
  } catch {
    rejectedBadPhrase = true;
  }
  if (!rejectedBadPhrase) {
    throw new Error("resetLibrary must reject a wrong confirmation phrase");
  }

  const settingsBeforeReset = getSettingsKeysStatus();
  const reset = resetLibrary(RESET_LIBRARY_CONFIRMATION_PHRASE);
  if (!reset.ok || reset.wiped.savedItems < 1 || reset.wiped.imports < 1) {
    throw new Error("resetLibrary should wipe existing content rows");
  }

  const afterReset = sqlite
    .prepare(
      `SELECT
        (SELECT count(*) FROM saved_items) AS items,
        (SELECT count(*) FROM imports) AS imports,
        (SELECT count(*) FROM item_collections) AS collections,
        (SELECT count(*) FROM import_schemas) AS schemas,
        (SELECT count(*) FROM saved_items_fts) AS fts,
        (SELECT count(*) FROM saved_items_vec_local) AS localVec,
        (SELECT count(*) FROM embedding_index_profiles) AS profiles,
        (SELECT count(*) FROM app_settings) AS settings`,
    )
    .get() as {
    items: number;
    imports: number;
    collections: number;
    schemas: number;
    fts: number;
    localVec: number;
    profiles: number;
    settings: number;
  };

  if (
    afterReset.items !== 0 ||
    afterReset.imports !== 0 ||
    afterReset.collections !== 0 ||
    afterReset.schemas !== 0 ||
    afterReset.fts !== 0 ||
    afterReset.localVec !== 0 ||
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

  try {
    fs.unlinkSync(tmpDb);
  } catch {
    // ignore cleanup errors
  }

  console.log("ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
