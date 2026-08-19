import fs from "node:fs";
import path from "node:path";
import type { TestContext } from "./harness";

/** Zip entry/total caps, path extract, SQL IN() chunking, label_values re-import. */
export async function runImportSafetySuite(ctx: TestContext) {
  console.log("[suite] import-safety");
  const { getSqlite } = await import("../../src/lib/db");
  const sqlite = getSqlite();
  const fixtures = ctx.fixtures;
  const { getSchemasForImport } = await import("../../src/lib/schema-catalog");

  // --- Gate B+: SQL IN() chunking + zip extract safety ---
  const {
    allSavesSearchRows,
    allLikesSearchRows,
    chunkIdsForSqlIn,
    SQL_IN_CLAUSE_BATCH_SIZE,
  } = await import("../../src/lib/search/sync");
  const {
    extractJsonFilesFromZip,
    ImportZipSafetyError,
    importExportArchive,
    importExportJson,
  } = await import("../../src/lib/import-export");
  const {
    IMPORT_MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
    IMPORT_MAX_EXTRACTED_JSON_BYTES,
    IMPORT_WRITE_BATCH_SIZE,
  } = await import("../../src/lib/import-limits");
  const AdmZip = (await import("adm-zip")).default;
  const nodeFs = await import("node:fs");
  const nodeOs = await import("node:os");
  const nodePath = await import("node:path");

  if (IMPORT_WRITE_BATCH_SIZE < 100 || IMPORT_WRITE_BATCH_SIZE > 5_000) {
    throw new Error("IMPORT_WRITE_BATCH_SIZE looks misconfigured");
  }

  const chunkProbe = chunkIdsForSqlIn(
    Array.from({ length: 1_250 }, (_, i) => i + 1),
  );
  if (
    chunkProbe.length !== 3 ||
    chunkProbe[0]!.length !== SQL_IN_CLAUSE_BATCH_SIZE ||
    chunkProbe[2]!.length !== 250
  ) {
    throw new Error("chunkIdsForSqlIn must split into ≤ SQL_IN_CLAUSE_BATCH_SIZE batches");
  }

  // Synthetic >32k ids: unchunked IN() hits SQLite variable limits and drops work.
  const OVER_SQLITE_IN_LIMIT = 40_000;
  const importRow = sqlite
    .prepare(
      `INSERT INTO imports (filename, content_hash, status, items_found, items_added)
       VALUES ('bulk-in-test.zip', ?, 'completed', 0, 0)`,
    )
    .run(`bulk-in-${Date.now()}`);
  const bulkImportId = Number(importRow.lastInsertRowid);
  const insertSaved = sqlite.prepare(
    `INSERT INTO saved_items (
      media_key, href, shortcode, media_type, author_username,
      first_seen_import_id, last_seen_import_id
    ) VALUES (?, ?, ?, 'reel', 'bulk.author', ?, ?)`,
  );
  const insertLiked = sqlite.prepare(
    `INSERT INTO liked_items (
      media_key, href, shortcode, media_type, author_username, source,
      first_seen_import_id, last_seen_import_id
    ) VALUES (?, ?, ?, 'reel', 'bulk.author', 'liked_posts', ?, ?)`,
  );
  sqlite.transaction(() => {
    for (let i = 0; i < OVER_SQLITE_IN_LIMIT; i++) {
      const key = `bulk-in-${i}`;
      insertSaved.run(key, `https://www.instagram.com/reel/${key}/`, key, bulkImportId, bulkImportId);
      insertLiked.run(
        `like-${key}`,
        `https://www.instagram.com/reel/like-${key}/`,
        `like-${key}`,
        bulkImportId,
        bulkImportId,
      );
    }
  })();

  const savesIds = (
    sqlite
      .prepare(`SELECT id FROM saved_items WHERE media_key LIKE 'bulk-in-%'`)
      .all() as Array<{ id: number }>
  ).map((r) => r.id);
  const likesIds = (
    sqlite
      .prepare(`SELECT id FROM liked_items WHERE media_key LIKE 'like-bulk-in-%'`)
      .all() as Array<{ id: number }>
  ).map((r) => r.id);
  if (savesIds.length !== OVER_SQLITE_IN_LIMIT || likesIds.length !== OVER_SQLITE_IN_LIMIT) {
    throw new Error("Failed to seed 40k saves/likes for IN() overflow test");
  }

  let savesLoaded: Array<{ id: number }>;
  let likesLoaded: Array<{ id: number }>;
  try {
    savesLoaded = allSavesSearchRows(sqlite, savesIds);
    likesLoaded = allLikesSearchRows(sqlite, likesIds);
  } catch (error) {
    throw new Error(
      `Chunked IN() lookup must not throw for ${OVER_SQLITE_IN_LIMIT} ids: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (savesLoaded.length !== OVER_SQLITE_IN_LIMIT) {
    throw new Error(
      `Chunked saves IN() silently dropped rows: got ${savesLoaded.length}, expected ${OVER_SQLITE_IN_LIMIT}`,
    );
  }
  if (likesLoaded.length !== OVER_SQLITE_IN_LIMIT) {
    throw new Error(
      `Chunked likes IN() silently dropped rows: got ${likesLoaded.length}, expected ${OVER_SQLITE_IN_LIMIT}`,
    );
  }
  sqlite.prepare(`DELETE FROM liked_items WHERE media_key LIKE 'like-bulk-in-%'`).run();
  sqlite.prepare(`DELETE FROM saved_items WHERE media_key LIKE 'bulk-in-%'`).run();
  sqlite.prepare(`DELETE FROM imports WHERE id = ?`).run(bulkImportId);

  // Zip entry / total budget fail closed (tiny limits so fixtures stay small).
  if (
    IMPORT_MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES < 64 * 1024 * 1024 ||
    IMPORT_MAX_EXTRACTED_JSON_BYTES < IMPORT_MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES
  ) {
    throw new Error("Production zip safety caps look misconfigured");
  }

  const okZip = new AdmZip();
  okZip.addFile(
    "your_instagram_activity/saved/saved_posts.json",
    Buffer.from('{"saved_saved_media":[]}', "utf8"),
  );
  const okFiles = await extractJsonFilesFromZip(okZip.toBuffer(), {
    zipSafetyLimits: {
      maxEntryUncompressedBytes: 10_000,
      maxTotalExtractedJsonBytes: 20_000,
    },
  });
  if (okFiles.length !== 1) {
    throw new Error("Under-cap zip should extract JSON entries");
  }

  // Path-based extract (production spool path) must not require a Buffer.
  const spoolZipPath = nodePath.join(
    nodeOs.tmpdir(),
    `ig-saves-spool-extract-${Date.now()}.zip`,
  );
  nodeFs.writeFileSync(spoolZipPath, okZip.toBuffer());
  try {
    const fromPath = await extractJsonFilesFromZip(spoolZipPath, {
      zipSafetyLimits: {
        maxEntryUncompressedBytes: 10_000,
        maxTotalExtractedJsonBytes: 20_000,
      },
    });
    if (fromPath.length !== 1 || fromPath[0]!.name !== okFiles[0]!.name) {
      throw new Error("Path-based yauzl extract must match buffer extract");
    }
  } finally {
    try {
      nodeFs.unlinkSync(spoolZipPath);
    } catch {
      // ignore
    }
  }

  const overEntryZip = new AdmZip();
  overEntryZip.addFile(
    "your_instagram_activity/saved/saved_posts.json",
    Buffer.alloc(2_000, 0x20),
  );
  let overEntryCaught = false;
  try {
    await extractJsonFilesFromZip(overEntryZip.toBuffer(), {
      zipSafetyLimits: {
        maxEntryUncompressedBytes: 500,
        maxTotalExtractedJsonBytes: 50_000,
      },
    });
  } catch (error) {
    overEntryCaught = error instanceof ImportZipSafetyError;
    if (
      !overEntryCaught ||
      !(error instanceof Error) ||
      !error.message.includes("too large when uncompressed")
    ) {
      throw new Error("Over-cap entry must throw ImportZipSafetyError with clear message");
    }
  }
  if (!overEntryCaught) {
    throw new Error("Over-cap zip entry must fail closed");
  }

  const overBudgetZip = new AdmZip();
  overBudgetZip.addFile("a.json", Buffer.from('{"a":1}', "utf8"));
  overBudgetZip.addFile("b.json", Buffer.from('{"b":2,"pad":"xxxxxxxxxxxxxxxx"}', "utf8"));
  let overBudgetCaught = false;
  try {
    await extractJsonFilesFromZip(overBudgetZip.toBuffer(), {
      zipSafetyLimits: {
        maxEntryUncompressedBytes: 10_000,
        maxTotalExtractedJsonBytes: 12,
      },
    });
  } catch (error) {
    overBudgetCaught = error instanceof ImportZipSafetyError;
    if (
      !overBudgetCaught ||
      !(error instanceof Error) ||
      !error.message.includes("in-memory budget")
    ) {
      throw new Error("Extract budget exceeded must throw ImportZipSafetyError with clear message");
    }
  }
  if (!overBudgetCaught) {
    throw new Error("Total extracted-JSON budget must fail closed");
  }

  const archiveFail = await importExportArchive(overEntryZip.toBuffer(), "bomb-entry.zip", {
    zipSafetyLimits: {
      maxEntryUncompressedBytes: 500,
      maxTotalExtractedJsonBytes: 50_000,
    },
  });
  if (
    archiveFail.status !== "failed" ||
    !archiveFail.message.includes("too large when uncompressed")
  ) {
    throw new Error("importExportArchive must surface zip safety failures as failed imports");
  }

  const { resetLibrary } = await import(
    "../../src/lib/settings/reset-library"
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
    .run("BackfillReel1");
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
    .run("LabelFmtReel01", "LabelFmtPost01");
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
      .get("LabelFmtReel01", "LabelFmtPost01") as { count: number }
  ).count;
  if (restoredAuthors !== 2) {
    throw new Error("label_values re-import should restore author_username and saved_at");
  }

  let rejectedBadPhrase = false;
  try {
    resetLibrary("wrong phrase", sqlite);
  } catch {
    rejectedBadPhrase = true;
  }
  if (!rejectedBadPhrase) {
    throw new Error("resetLibrary must reject a wrong confirmation phrase");
  }

}
