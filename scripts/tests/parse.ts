import fs from "node:fs";
import path from "node:path";
import type { TestContext } from "./harness";

/** Parse fixtures, import dedupe, likes, settings/provider enable gates. */
export async function runParseSuite(ctx: TestContext) {
  console.log("[suite] parse");
  const { parseExportJsonFiles } = await import("../../src/lib/parse-export");
  const { importExportJson } = await import("../../src/lib/import-export");
  const { listSaves } = await import("../../src/lib/queries");
  const { rebuildSearchIndex } = await import("../../src/lib/search/sync");
  const { getProviderAvailability } = await import(
    "../../src/lib/search/providers"
  );
  const { getSqlite } = await import("../../src/lib/db");
  const {
    getSettingsKeysStatus,
    updateSettingsKeys,
  } = await import("../../src/lib/settings/credentials");

  const fixtures = ctx.fixtures;

  const files = ctx.files;

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

  // 2025/2026 Instagram export shape: top-level array of
  // { timestamp, media, label_values, fbid } with Owner.Username nested.
  const labelValuesParsed = parseExportJsonFiles([
    {
      name: "your_instagram_activity/saved/saved_posts.json",
      content: fs.readFileSync(
        path.join(fixtures, "sample-saved-posts-label-values.json"),
        "utf8",
      ),
    },
    {
      name: "your_instagram_activity/saved/saved_collections.json",
      content: fs.readFileSync(
        path.join(fixtures, "sample-saved-collections-label-values.json"),
        "utf8",
      ),
    },
  ]);
  const labelReel = labelValuesParsed.items.find(
    (item) => item.mediaKey === "labelfmtreel01",
  );
  const labelPost = labelValuesParsed.items.find(
    (item) => item.mediaKey === "labelfmtpost01",
  );
  const labelCollOnly = labelValuesParsed.items.find(
    (item) => item.mediaKey === "labelfmtcollonly",
  );
  if (
    !labelReel?.authorUsername ||
    labelReel.authorUsername !== "fixture.creator" ||
    !labelReel.savedAt ||
    !labelReel.collections.includes("Recipes")
  ) {
    throw new Error(
      "label_values posts should parse Owner.Username, timestamp, and collection Media membership",
    );
  }
  if (!labelPost?.authorUsername || labelPost.authorUsername !== "other.creator") {
    throw new Error("label_values post author should come from Owner.Username");
  }
  if (
    !labelCollOnly?.authorUsername ||
    labelCollOnly.authorUsername !== "coll.only.user" ||
    !labelCollOnly.collections.includes("Recipes")
  ) {
    throw new Error("label_values collection-only media should parse author + tag");
  }
  const labelAuthors = labelValuesParsed.items.filter((i) => i.authorUsername).length;
  const labelWithDates = labelValuesParsed.items.filter((i) => i.savedAt).length;
  if (labelAuthors < 3 || labelWithDates < 2) {
    throw new Error(
      `label_values parse expected authors>=3 dates>=2, got authors=${labelAuthors} dates=${labelWithDates}`,
    );
  }

  const { parseLikedExportJsonFiles } = await import("../../src/lib/parse-export");
  const likedParsed = parseLikedExportJsonFiles([
    {
      name: "your_instagram_activity/likes/liked_posts.json",
      content: fs.readFileSync(
        path.join(fixtures, "sample-liked-posts-label-values.json"),
        "utf8",
      ),
    },
    {
      name: "your_instagram_activity/story_interactions/story_likes.json",
      content: fs.readFileSync(
        path.join(fixtures, "sample-story-likes-label-values.json"),
        "utf8",
      ),
    },
    {
      name: "your_instagram_activity/likes/liked_comments.json",
      content: fs.readFileSync(
        path.join(fixtures, "sample-liked-comments.json"),
        "utf8",
      ),
    },
  ]);
  const likedReel = likedParsed.items.find(
    (item) => item.mediaKey === "likedfmtreel01",
  );
  const likedStory = likedParsed.items.find((item) =>
    item.mediaKey.startsWith("story:story.author:"),
  );
  const likedComment = likedParsed.items.find((item) =>
    item.mediaKey.startsWith("comment:"),
  );
  if (
    !likedReel?.authorUsername ||
    likedReel.authorUsername !== "liked.creator" ||
    likedReel.mediaType !== "reel" ||
    !likedReel.likedAt
  ) {
    throw new Error("liked_posts label_values should parse reel + Owner.Username");
  }
  if (
    !likedStory ||
    likedStory.mediaType !== "story" ||
    likedStory.authorUsername !== "story.author"
  ) {
    throw new Error("story_likes should detect story type and author from URL/Owner");
  }
  if (
    !likedComment ||
    likedComment.mediaType !== "comment" ||
    likedComment.authorUsername !== "comment.author"
  ) {
    throw new Error("liked_comments should parse comment likes with author title");
  }
  if (likedParsed.items.length < 4) {
    throw new Error(
      `Expected at least 4 liked items from fixtures, got ${likedParsed.items.length}`,
    );
  }

  const likesImport = await importExportJson(
    fs.readFileSync(
      path.join(fixtures, "sample-liked-posts-label-values.json"),
      "utf8",
    ),
    "your_instagram_activity/likes/liked_posts.json",
  );
  if (
    likesImport.status !== "completed" ||
    (likesImport.likesAdded ?? 0) < 2 ||
    likesImport.itemsAdded !== 0
  ) {
    throw new Error(
      `Likes-only JSON import should add likes without saves: ${JSON.stringify(likesImport)}`,
    );
  }
  if (
    !likesImport.log ||
    likesImport.log.likesParsed < 2 ||
    likesImport.log.likesAuthorsFound < 1 ||
    likesImport.log.likesAdded < 2 ||
    (likesImport.log.authorsFound ?? 0) !== 0
  ) {
    throw new Error(
      `Likes import log should report likes metrics separately from saves authors (got ${JSON.stringify(likesImport.log)})`,
    );
  }
  {
    const { parseImportLog, resolveAuthorMetrics } = await import(
      "../../src/lib/import-log"
    );
    const legacy = parseImportLog(
      JSON.stringify({
        filesScanned: 3,
        jsonFilesParsed: 5,
        savedJsonFiles: ["saved_posts.json"],
        likedJsonFiles: ["liked_posts.json"],
        itemsParsed: 10,
        likesParsed: 100,
        typeCounts: { post: 10, reel: 0, igtv: 0, unknown: 0 },
        likeTypeCounts: {
          post: 100,
          reel: 0,
          igtv: 0,
          story: 0,
          comment: 0,
          unknown: 0,
        },
        collectionsFound: [],
        authorsFound: 110,
        itemsWithSavedAt: 10,
        likesWithLikedAt: 100,
        warnings: ["Likes: 100 added, 0 updated, 0 unchanged."],
      }),
    );
    if (!legacy || legacy.likesAdded !== 100 || legacy.likesSkipped !== 0) {
      throw new Error(
        `parseImportLog should recover likes write metrics from legacy warnings (got ${JSON.stringify(legacy)})`,
      );
    }
    const authors = resolveAuthorMetrics(legacy);
    if (authors.savesWithAuthor !== 10 || authors.likesWithAuthor !== 100) {
      throw new Error(
        `resolveAuthorMetrics should split legacy authorsFound (got ${JSON.stringify(authors)})`,
      );
    }
  }
  const likesDup = await importExportJson(
    fs.readFileSync(
      path.join(fixtures, "sample-liked-posts-label-values.json"),
      "utf8",
    ),
    "your_instagram_activity/likes/liked_posts.json",
  );
  if (
    likesDup.status !== "duplicate" ||
    !likesDup.log ||
    likesDup.log.likesSkipped < 2 ||
    likesDup.likesSkipped < 2
  ) {
    throw new Error(
      `Duplicate likes import should persist likesSkipped in log/result (got ${JSON.stringify(likesDup)})`,
    );
  }
  const { listLikes, getStats } = await import("../../src/lib/queries");
  const likesList = await listLikes({ pageSize: 50 });
  if (likesList.total < 2) {
    throw new Error("listLikes should return imported liked posts");
  }
  if (typeof likesList.items[0]?.alsoSaved !== "boolean") {
    throw new Error("listLikes should include alsoSaved on each row");
  }
  const likesSearch = await listLikes({ q: "liked.creator", pageSize: 10 });
  if (likesSearch.total < 1) {
    throw new Error("Likes FTS/LIKE search should find liked.creator");
  }
  const statsWithLikes = getStats();
  if (
    !Array.isArray(statsWithLikes.topLikedAuthors) ||
    statsWithLikes.topLikedAuthors.length < 1
  ) {
    throw new Error("Overview stats should include topLikedAuthors after likes import");
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
    sampleArrayIndices,
    SCHEMA_ARRAY_SAMPLE,
  } = await import("../../src/lib/json-schema-infer");
  const { getSchemasForImport, getAggregatedSchemas } = await import(
    "../../src/lib/schema-catalog"
  );

  const inferred = catalogSchemasFromFiles([
    { name: files[0].name, content: files[0].content },
  ]);
  if (inferred.length !== 1 || inferred[0]?.topLevelType !== "object") {
    throw new Error("Schema inference should see object top-level for saved posts");
  }
  if (inferred[0]?.truncatedRead) {
    throw new Error("Full-file schema inference should not mark truncatedRead");
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
  // Nesting past the old depth-7 cap must still walk keys/types.
  let nested: unknown = { leaf: true };
  for (let i = 0; i < 12; i++) nested = { child: nested };
  const deepWalk = inferSchemaFromValue(nested);
  let cursor = deepWalk;
  for (let i = 0; i < 12; i++) {
    if (cursor.keys?.child?.type !== "object") {
      throw new Error(`Deep nest walk should continue past level ${i}`);
    }
    cursor = cursor.keys.child;
  }
  if (cursor.keys?.leaf?.type !== "boolean") {
    throw new Error("Deep nest walk should reach boolean leaf at depth 12+");
  }

  const shortIdx = sampleArrayIndices(15);
  if (shortIdx.length !== 15 || shortIdx[0] !== 0 || shortIdx[14] !== 14) {
    throw new Error("Array sampling should use all elements when length ≤ 20");
  }
  let randCalls = 0;
  const longIdx = sampleArrayIndices(100, () => {
    randCalls += 1;
    return 0.5;
  });
  if (longIdx.length !== SCHEMA_ARRAY_SAMPLE) {
    throw new Error(
      `Array sampling should return ${SCHEMA_ARRAY_SAMPLE} indices, got ${longIdx.length}`,
    );
  }
  for (let i = 0; i < 7; i++) {
    if (!longIdx.includes(i) || !longIdx.includes(99 - i)) {
      throw new Error("Array sampling must include first 7 and last 7 indices");
    }
  }
  if (randCalls < 1) {
    throw new Error("Array sampling should draw random middle indices");
  }
  const sampled = inferSchemaFromValue(
    Array.from({ length: 50 }, (_, i) => ({ [`k${i}`]: i })),
  );
  if (sampled.arrayLength?.sample !== SCHEMA_ARRAY_SAMPLE) {
    throw new Error("Inferred array schema should report sample count ≤ 20");
  }
  if (!sampled.items?.keys?.k0 || !sampled.items.keys.k49) {
    throw new Error("Array element merge should include first and last sample keys");
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
    settingsAfterKeys.openai.enabled.saves ||
    settingsAfterKeys.openai.enabled.likes ||
    settingsAfterKeys.voyage.enabled.saves ||
    settingsAfterKeys.voyage.enabled.likes ||
    settingsAfterKeys.ollama.enabled.saves ||
    settingsAfterKeys.ollama.enabled.likes ||
    settingsAfterKeys.ollama.available ||
    !settingsAfterKeys.local.enabled.saves ||
    !settingsAfterKeys.local.enabled.likes ||
    settingsAfterKeys.ollama.model !== "qwen3-embedding:0.6b" ||
    settingsAfterKeys.openai.model !== "text-embedding-3-small" ||
    settingsAfterKeys.voyage.model !== "voyage-4-lite" ||
    settingsAfterKeys.preferredProvider !== "openai" ||
    settingsAfterKeys.timeoutMs !== 10000
  ) {
    throw new Error(
      "Settings should persist keys without enabling indexes; local defaults on for both libraries",
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
    !settingsAfter.openai.enabled.saves ||
    !settingsAfter.openai.enabled.likes ||
    !settingsAfter.voyage.enabled.saves ||
    !settingsAfter.voyage.enabled.likes ||
    !settingsAfter.ollama.enabled.saves ||
    !settingsAfter.ollama.enabled.likes ||
    !settingsAfter.ollama.available ||
    !settingsAfter.local.enabled.saves ||
    !settingsAfter.local.enabled.likes
  ) {
    throw new Error("Explicit enable flags should turn indexes on for both libraries");
  }

  // Independent library enables: OpenAI Saves-only should not appear on Likes.
  updateSettingsKeys({
    openaiEnabled: { saves: true, likes: false },
  });
  const {
    getProviderAvailability: getAvailabilityForLibrary,
  } = await import("../../src/lib/search/providers");
  const savesOpenai = getAvailabilityForLibrary("saves");
  const likesOpenai = getAvailabilityForLibrary("likes");
  if (!savesOpenai.configured.openai || likesOpenai.configured.openai) {
    throw new Error(
      "OpenAI enabled for Saves only must configure Saves and leave Likes unavailable",
    );
  }
  updateSettingsKeys({
    openaiEnabled: { saves: true, likes: true },
  });

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

  const mock = ctx.mockFetch;
  mock.embeddingRequests = 0;
  mock.failEmbeddingRequests = false;
  mock.embeddingBodies = [];
  mock.embeddingUrls = [];
  globalThis.fetch = async (input, init) => {
    mock.embeddingRequests += 1;
    mock.embeddingUrls.push(String(input));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    mock.embeddingBodies.push(body);
    if (mock.failEmbeddingRequests) throw new Error("mock network unavailable");
    const dimensions =
      typeof body.output_dimension === "number"
        ? body.output_dimension
        : Number(body.dimensions);
    const inputValue = body.input;
    const batchSize = Array.isArray(inputValue) ? inputValue.length : 1;
    return Response.json({
      data: Array.from({ length: batchSize }, (_, index) => ({
        index,
        embedding: Array.from({ length: dimensions }, (__, i) => (i ? 0 : 1)),
      })),
    });
  };
  // mock.* is the shared counter surface for later suites (sync-upsert).

  const mismatchSearch = await listSaves({
    q: "chef.daily",
    provider: "openai",
  });
  if (
    mismatchSearch.searchMode !== "hybrid-local-fallback" ||
    mismatchSearch.providerFallback !== true ||
    mock.embeddingRequests !== 0
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
    mock.embeddingRequests < 1
  ) {
    throw new Error("OpenAI index and query should use the mock OpenAI path");
  }

  const ollamaSearch = await listSaves({
    q: "chef.daily",
    provider: "ollama",
  });
  const ollamaQueryUrl = mock.embeddingUrls.at(-1);
  const ollamaQueryBody = mock.embeddingBodies.at(-1);
  if (
    !["hybrid", "vec"].includes(ollamaSearch.searchMode ?? "") ||
    ollamaSearch.searchProvider !== "ollama" ||
    ollamaQueryUrl !== "http://127.0.0.1:11434/v1/embeddings" ||
    ollamaQueryBody?.dimensions !== 1024 ||
    ollamaQueryBody?.model !== "qwen3-embedding:0.6b"
  ) {
    throw new Error("Ollama search should hit OpenAI-compatible embeddings API");
  }

  const requestsBeforeFailure = mock.embeddingRequests;
  mock.failEmbeddingRequests = true;
  const offlineFallbackSearch = await listSaves({
    q: "chef.daily",
    provider: "openai",
  });
  mock.failEmbeddingRequests = false;
  if (
    offlineFallbackSearch.searchMode !== "hybrid-local-fallback" ||
    offlineFallbackSearch.searchProvider !== "local" ||
    offlineFallbackSearch.providerFallback !== true ||
    mock.embeddingRequests !== requestsBeforeFailure + 1
  ) {
    throw new Error("Remote query failure must fall back to local vectors");
  }

  const requestsBeforeRemoteImport = mock.embeddingRequests;
  const remoteImport = await importExportJson(
    files[0].content.replace("AbCdEfGhIjK", "OpenAITst12"),
    "saved_posts_openai.json",
  );
  console.log("OpenAI+Voyage+Ollama import:", remoteImport);
  if (
    remoteImport.status !== "completed" ||
    mock.embeddingRequests !== requestsBeforeRemoteImport + 3 ||
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
  if (mock.embeddingUrls.some((url) => !allowedEndpoints.has(url))) {
    throw new Error("Unexpected embedding endpoint in mock requests");
  }

  const voyageSearch = await listSaves({
    q: "chef.daily",
    provider: "voyage",
  });
  const voyageQueryBody = mock.embeddingBodies.at(-1);
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

}
