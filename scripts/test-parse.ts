import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
  const tmpDb = path.join(
    os.tmpdir(),
    `instagram-saves-test-${Date.now()}.db`,
  );
  process.env.INSTAGRAM_SAVES_DB = tmpDb;
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  delete process.env.VOYAGE_API_KEY;

  const { parseExportJsonFiles } = await import("../src/lib/parse-export");
  const { importExportJson } = await import("../src/lib/import-export");
  const { listSaves } = await import("../src/lib/queries");
  const { rebuildSearchIndex } = await import("../src/lib/search/sync");
  const { getProviderAvailability } = await import(
    "../src/lib/search/providers"
  );
  const { getSqlite } = await import("../src/lib/db");

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
  console.log("parsed count:", parsed.length);
  console.log(
    parsed.map((item) => ({
      key: item.mediaKey,
      type: item.mediaType,
      author: item.authorUsername,
      collections: item.collections,
    })),
  );

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

  if (parsed.length < 3) {
    throw new Error(`Expected at least 3 unique items, got ${parsed.length}`);
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

  process.env.OPENAI_API_KEY = "test-key";
  process.env.EMBEDDING_MODEL = "text-embedding-3-small";
  process.env.VOYAGE_API_KEY = "test-voyage-key";
  process.env.VOYAGE_MODEL = "voyage-4-lite";

  const availabilityBoth = getProviderAvailability();
  if (
    availabilityBoth.available.join(",") !== "local,openai,voyage" ||
    availabilityBoth.default !== "openai"
  ) {
    throw new Error("Both remote keys should expose openai+voyage modes");
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
  if (openAiCount !== 3 || voyageCount !== 3) {
    throw new Error("Reindex should cover openai and voyage indexes");
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
  console.log("OpenAI+Voyage import:", remoteImport);
  if (
    remoteImport.status !== "completed" ||
    embeddingRequests !== requestsBeforeRemoteImport + 2 ||
    !remoteImport.message.includes("openai") ||
    !remoteImport.message.includes("voyage")
  ) {
    throw new Error("Changed imports should update both remote indexes");
  }
  const vectorCounts = sqlite
    .prepare(
      `SELECT
        (SELECT count(*) FROM saved_items_vec_local) AS localCount,
        (SELECT count(*) FROM saved_items_vec_openai) AS openAiCount,
        (SELECT count(*) FROM saved_items_vec_voyage) AS voyageCount`,
    )
    .get() as {
    localCount: number;
    openAiCount: number;
    voyageCount: number;
  };
  if (
    vectorCounts.localCount !== 4 ||
    vectorCounts.openAiCount !== 4 ||
    vectorCounts.voyageCount !== 4
  ) {
    throw new Error("Imports must update local, openai, and voyage indexes");
  }
  if (
    embeddingUrls.some(
      (url) =>
        url !== "https://api.openai.com/v1/embeddings" &&
        url !== "https://api.voyageai.com/v1/embeddings",
    )
  ) {
    throw new Error("Unexpected embedding endpoint in mock requests");
  }

  const voyageSearch = await listSaves({
    q: "chef.daily",
    provider: "voyage",
  });
  const voyageQueryBody = embeddingBodies.at(-1);
  if (
    !["hybrid", "vec"].includes(voyageSearch.searchMode) ||
    voyageSearch.searchProvider !== "voyage" ||
    voyageQueryBody?.input_type !== "query" ||
    voyageQueryBody?.output_dimension !== 1024
  ) {
    throw new Error(
      "Voyage search should use native endpoint, 1024 dims, and query input_type",
    );
  }

  delete process.env.OPENAI_API_KEY;
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
