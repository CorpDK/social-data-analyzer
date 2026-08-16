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
  process.env.EMBEDDING_WORKER_INLINE = "1";
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

  const { parseLikedExportJsonFiles } = await import("../src/lib/parse-export");
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
      "../src/lib/import-log"
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
  const { listLikes, getStats } = await import("../src/lib/queries");
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
  } = await import("../src/lib/search/providers");
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
    const inputValue = body.input;
    const batchSize = Array.isArray(inputValue) ? inputValue.length : 1;
    return Response.json({
      data: Array.from({ length: batchSize }, (_, index) => ({
        index,
        embedding: Array.from({ length: dimensions }, (__, i) => (i ? 0 : 1)),
      })),
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
  if (
    !statusBefore.libraries?.saves ||
    !statusBefore.libraries?.likes ||
    statusBefore.libraries.likes.providers.length !== 4
  ) {
    throw new Error("Status should include dual Saves/Likes library sections");
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
  // Disabling Saves OpenAI must not flip Likes when set independently.
  updateSettingsKeys({
    openaiEnabled: { saves: false, likes: true },
  });
  const likesOnlyOpenAi = getSearchIndexStatus().libraries.likes.providers.find(
    (p) => p.provider === "openai",
  );
  const savesOnlyOpenAi = getSearchIndexStatus().libraries.saves.providers.find(
    (p) => p.provider === "openai",
  );
  if (
    !likesOnlyOpenAi?.enabled ||
    !likesOnlyOpenAi.configured ||
    savesOnlyOpenAi?.enabled ||
    savesOnlyOpenAi?.configured
  ) {
    throw new Error(
      "Per-library OpenAI enable should differ between Saves and Likes status rows",
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

  // all-configured expands to one job per enabled provider × library (saves + likes).
  const allJobs = startReindexJob("all-configured");
  if (!allJobs.ok) {
    throw new Error(`Failed to start all-configured reindex: ${allJobs.error}`);
  }
  if (allJobs.jobs.length < 4) {
    throw new Error(
      `all-configured should enqueue saves+likes provider jobs (got ${allJobs.jobs.length})`,
    );
  }
  if (allJobs.jobs.some((job) => job.target === "all-configured")) {
    throw new Error("Expanded jobs must use concrete provider targets");
  }
  if (!allJobs.jobs.some((job) => job.target.startsWith("likes-"))) {
    throw new Error("all-configured should include likes-* job targets");
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

  // --- Resume + RAM gate helpers (no real Ollama / large DB work) ---
  const {
    assessReindexMemory,
    CRITICAL_MIN_AVAILABLE_MB,
    OLLAMA_LARGE_MIN_AVAILABLE_MB,
    REMOTE_LARGE_MIN_AVAILABLE_MB,
    mergeNodeOptionsMaxOldSpace,
  } = await import("../src/lib/search/memory");
  const { rebuildProviderIndex } = await import("../src/lib/search/sync");

  const refuseLarge = assessReindexMemory("likes", "ollama", 25_000, 800);
  if (!refuseLarge.refuse || !refuseLarge.refuseReason) {
    throw new Error("Ollama likes reindex must refuse when MemAvailable is low");
  }
  const allowSmall = assessReindexMemory("saves", "ollama", 100, 900);
  if (allowSmall.refuse) {
    throw new Error("Small saves Ollama reindex should not hard-refuse at ~900 MB");
  }
  if (!allowSmall.warning) {
    throw new Error("Small saves Ollama reindex should soft-warn when RAM is tight");
  }
  const softVoyage = assessReindexMemory("likes", "voyage", 25_000, 4_000);
  if (softVoyage.refuse || !softVoyage.warning) {
    throw new Error("Large Voyage likes reindex should warn but not refuse at 4 GiB");
  }
  const refuseVoyageLarge = assessReindexMemory("likes", "voyage", 25_000, 800);
  if (!refuseVoyageLarge.refuse || !refuseVoyageLarge.refuseReason) {
    throw new Error("Large Voyage likes reindex must refuse below remote large floor");
  }
  const refuseCriticalVoyage = assessReindexMemory("saves", "openai", 100, 400);
  if (!refuseCriticalVoyage.refuse) {
    throw new Error("Any provider must refuse when MemAvailable is critically low");
  }
  const allowVoyageLarge = assessReindexMemory("likes", "voyage", 25_000, 1_200);
  if (allowVoyageLarge.refuse) {
    throw new Error("Large Voyage likes should be allowed above remote large floor");
  }
  if (!allowVoyageLarge.warning) {
    throw new Error("Large Voyage likes should soft-warn when allowed");
  }
  if (OLLAMA_LARGE_MIN_AVAILABLE_MB < 1024) {
    throw new Error("Ollama large threshold should be at least 1 GiB");
  }
  if (REMOTE_LARGE_MIN_AVAILABLE_MB < CRITICAL_MIN_AVAILABLE_MB) {
    throw new Error("Remote large floor must be above critical floor");
  }
  const mergedOpts = mergeNodeOptionsMaxOldSpace("--enable-source-maps", 2048);
  if (
    !mergedOpts.includes("--enable-source-maps") ||
    !mergedOpts.includes("--max-old-space-size=2048")
  ) {
    throw new Error("NODE_OPTIONS merge must append max-old-space-size");
  }
  const keepExisting = mergeNodeOptionsMaxOldSpace(
    "--max-old-space-size=4096 --trace-warnings",
    2048,
  );
  if (!keepExisting.includes("--max-old-space-size=4096")) {
    throw new Error("NODE_OPTIONS merge must not overwrite existing heap cap");
  }

  const statusWithHost = getSearchIndexStatus();
  if (
    !statusWithHost.host ||
    typeof statusWithHost.host.ollamaLargeMinAvailableMb !== "number" ||
    typeof statusWithHost.host.criticalMinAvailableMb !== "number" ||
    typeof statusWithHost.host.remoteLargeMinAvailableMb !== "number"
  ) {
    throw new Error("Status payload must include host memory thresholds");
  }

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
  const { writeEmbeddingChunk } = await import("../src/lib/search/sync");
  const { embeddingConfigForProvider } = await import(
    "../src/lib/search/embeddings"
  );
  const localDims = embeddingConfigForProvider("local").profile.dimensions;
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

  // --- Worker spawn guards: terminal jobs, disabled providers, retry caps ---
  const {
    embeddingJobSpawnBlockReason,
    classifyWorkerExit,
    planWorkerRetry,
    embeddingWorkerRetryDelayMs,
    MAX_EMBEDDING_WORKER_ATTEMPTS,
    EMBEDDING_WORKER_FAST_FAILURE_MS,
    ensureJobRunner,
    getEmbeddingJob,
  } = await import("../src/lib/search/jobs");

  const insertJobRow = (target: string, state: string): number => {
    const info = sqlite
      .prepare(
        `INSERT INTO embedding_jobs(target, state, phase, processed, total, message)
         VALUES (?, ?, 'queued', 0, 0, 'synthetic test row')`,
      )
      .run(target, state);
    return Number(info.lastInsertRowid);
  };

  const failedJobId = insertJobRow("local", "failed");
  const failedReason = embeddingJobSpawnBlockReason(failedJobId);
  if (!failedReason || !failedReason.includes("failed")) {
    throw new Error("A failed job must never be startable by a worker");
  }
  ensureJobRunner();
  if (getEmbeddingJob(failedJobId)?.state !== "failed") {
    throw new Error("Terminal jobs must not be revived by the queue");
  }
  if (embeddingJobSpawnBlockReason(failedJobId + 10_000) === null) {
    throw new Error("A missing job must never be startable");
  }

  // A provider disabled after enqueue must fail its queued job, not spawn for it.
  updateSettingsKeys({ voyageEnabled: false });
  const staleVoyageJobId = insertJobRow("voyage", "pending");
  const staleReason = embeddingJobSpawnBlockReason(staleVoyageJobId);
  if (!staleReason || !staleReason.includes("not enabled")) {
    throw new Error(
      `Queued job for a disabled provider must be blocked (got ${staleReason})`,
    );
  }
  ensureJobRunner();
  const staleVoyageJob = getEmbeddingJob(staleVoyageJobId);
  if (staleVoyageJob?.state !== "failed" || !staleVoyageJob.error) {
    throw new Error(
      `Stale disabled-provider job should fail terminally (got ${staleVoyageJob?.state})`,
    );
  }
  updateSettingsKeys({ voyageEnabled: true });

  const enabledLocalJobId = insertJobRow("local", "pending");
  if (embeddingJobSpawnBlockReason(enabledLocalJobId) !== null) {
    throw new Error("An enabled provider's pending job should be startable");
  }
  sqlite
    .prepare(
      `UPDATE embedding_jobs SET state = 'cancelled', finished_at = unixepoch() WHERE id = ?`,
    )
    .run(enabledLocalJobId);
  if (embeddingJobSpawnBlockReason(enabledLocalJobId) === null) {
    throw new Error("A cancelled job must never be startable");
  }

  // Retry classification: only slow, non-cancelled failures may respawn.
  if (
    classifyWorkerExit({ code: 0, signal: null, elapsedMs: 10_000 }) !== "ok"
  ) {
    throw new Error("Exit code 0 should classify as ok");
  }
  if (
    classifyWorkerExit({
      code: 1,
      signal: null,
      elapsedMs: EMBEDDING_WORKER_FAST_FAILURE_MS - 1,
    }) !== "permanent"
  ) {
    throw new Error("Instant worker failures must be permanent (no respawn)");
  }
  if (
    classifyWorkerExit({ code: 3, signal: null, elapsedMs: 60_000 }) !==
    "permanent"
  ) {
    throw new Error("Worker exit code 3 must be permanent");
  }
  if (
    classifyWorkerExit({
      code: 1,
      signal: null,
      elapsedMs: 30_000,
      cancelRequested: true,
    }) !== "cancelled"
  ) {
    throw new Error("Cancelled runs must not be retried as failures");
  }
  if (
    classifyWorkerExit({ code: null, signal: null, elapsedMs: 5, spawnFailed: true }) !==
    "permanent"
  ) {
    throw new Error("Spawn failures must be permanent");
  }
  const transientExit = classifyWorkerExit({
    code: 1,
    signal: null,
    elapsedMs: 30_000,
  });
  if (transientExit !== "transient") {
    throw new Error("Slow non-zero exits should be retryable");
  }

  const firstRetry = planWorkerRetry(1, "transient");
  const secondRetry = planWorkerRetry(2, "transient");
  const cappedRetry = planWorkerRetry(MAX_EMBEDDING_WORKER_ATTEMPTS, "transient");
  if (!firstRetry.retry || firstRetry.delayMs < 1_000) {
    throw new Error("First transient failure should retry after a backoff");
  }
  if (!secondRetry.retry || secondRetry.delayMs <= firstRetry.delayMs) {
    throw new Error("Backoff must grow between attempts");
  }
  if (cappedRetry.retry) {
    throw new Error(
      `Retries must stop at ${MAX_EMBEDDING_WORKER_ATTEMPTS} attempts`,
    );
  }
  if (planWorkerRetry(1, "permanent").retry) {
    throw new Error("Permanent failures must never retry");
  }
  if (embeddingWorkerRetryDelayMs(1) !== 1_000) {
    throw new Error("First retry backoff should be 1s");
  }
  if (embeddingWorkerRetryDelayMs(99) < embeddingWorkerRetryDelayMs(2)) {
    throw new Error("Backoff lookup should clamp to the longest delay");
  }

  // --- SSE re-entrancy: a status subscriber must not re-queue a claimed job ---
  // This mirrors the /api/search/status/stream handler, whose every snapshot
  // calls ensureJobRunner(). Job writes publish synchronously, so an unclaimed
  // runner used to re-queue the row it had just started and start it again.
  const { subscribeJobEvents, SEARCH_STATUS_CHANNEL } = await import(
    "../src/lib/sse"
  );
  let maxConcurrentRunning = 0;
  let reentrantPumps = 0;
  const unsubscribeStatus = subscribeJobEvents(SEARCH_STATUS_CHANNEL, () => {
    reentrantPumps += 1;
    const running = (
      sqlite
        .prepare(`SELECT count(*) AS c FROM embedding_jobs WHERE state = 'running'`)
        .get() as { c: number }
    ).c;
    maxConcurrentRunning = Math.max(maxConcurrentRunning, running);
    ensureJobRunner();
  });

  try {
    const reentrant = startReindexJob("local");
    if (!reentrant.ok) {
      throw new Error(`Reentrancy job should start: ${reentrant.error}`);
    }
    const reentrantSettled = await waitForIdleJob(60_000);
    if (reentrantSettled?.state !== "completed") {
      throw new Error(
        `Job should complete once with SSE subscribers attached (got ${reentrantSettled?.state}: ${reentrantSettled?.error})`,
      );
    }
    if (reentrantPumps === 0) {
      throw new Error("Expected the status subscriber to observe job events");
    }
    if (maxConcurrentRunning > 1) {
      throw new Error(
        `Only one job may run at a time (saw ${maxConcurrentRunning})`,
      );
    }
    const reentrantJob = getEmbeddingJob(reentrant.job.id);
    if (reentrantJob?.state !== "completed") {
      throw new Error(
        `Re-entrancy guard job should end completed (got ${reentrantJob?.state})`,
      );
    }
  } finally {
    unsubscribeStatus();
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
  if (!backfillAgain.importId) {
    throw new Error("Duplicate backfill import should return importId");
  }
  const backfillSchemas = getSchemasForImport(backfillAgain.importId);
  if (backfillSchemas.length < 1) {
    throw new Error("Duplicate re-import must still capture import_schemas");
  }

  const labelBackfill = fs.readFileSync(
    path.join(fixtures, "sample-saved-posts-label-values.json"),
    "utf8",
  );
  const labelFirst = await importExportJson(
    labelBackfill,
    "label-values-saved.json",
  );
  if (labelFirst.status !== "completed" || labelFirst.itemsAdded < 2) {
    throw new Error("label_values fixture should import items");
  }
  if (
    !labelFirst.log ||
    labelFirst.log.authorsFound < 2 ||
    labelFirst.log.itemsWithSavedAt < 2
  ) {
    throw new Error(
      `label_values import log should report authors/dates (got ${JSON.stringify(labelFirst.log)})`,
    );
  }
  sqlite
    .prepare(
      "UPDATE saved_items SET author_username = NULL, saved_at = NULL WHERE media_key IN (?, ?)",
    )
    .run("labelfmtreel01", "labelfmtpost01");
  const labelAgain = await importExportJson(
    labelBackfill,
    "label-values-saved.json",
  );
  if (labelAgain.status !== "duplicate" || labelAgain.itemsUpdated < 2) {
    throw new Error(
      `label_values duplicate re-import should backfill metadata (updated=${labelAgain.itemsUpdated})`,
    );
  }
  const restoredAuthors = (
    sqlite
      .prepare(
        "SELECT count(*) AS count FROM saved_items WHERE media_key IN (?, ?) AND author_username IS NOT NULL AND saved_at IS NOT NULL",
      )
      .get("labelfmtreel01", "labelfmtpost01") as { count: number }
  ).count;
  if (restoredAuthors !== 2) {
    throw new Error("label_values re-import should restore author_username and saved_at");
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

  // --- Chunked sync + API batching (synthetic; no real remote / prod DB) ---
  {
    const {
      EMBEDDING_SYNC_CHUNK_SIZE,
      rebuildProviderIndex,
    } = await import("../src/lib/search/sync");
    const { EMBEDDING_API_BATCH_SIZE } = await import(
      "../src/lib/search/embeddings"
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

    const requestsBeforeBatch = embeddingRequests;
    await rebuildProviderIndex("likes", "openai");
    const batchRequests = embeddingRequests - requestsBeforeBatch;
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
  const reset = resetLibrary(RESET_LIBRARY_CONFIRMATION_PHRASE);
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
