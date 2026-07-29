import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
  const tmpDb = path.join(
    os.tmpdir(),
    `instagram-saves-test-${Date.now()}.db`,
  );
  process.env.INSTAGRAM_SAVES_DB = tmpDb;

  const { parseExportJsonFiles } = await import("../src/lib/parse-export");
  const { importExportJson } = await import("../src/lib/import-export");

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

  const first = importExportJson(files[0].content, "sample-saved-posts.json");
  console.log("first import:", first);

  const second = importExportJson(files[0].content, "sample-saved-posts.json");
  console.log("duplicate import:", second);

  const merged = importExportJson(
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
