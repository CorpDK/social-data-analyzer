import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { and, eq } from "drizzle-orm";
import { getDb, getSqlite, schema } from "./db";
import { parseExportJsonFiles, type ParsedSavedItem } from "./parse-export";
import { syncItemEmbeddings, upsertItemFts } from "./search/sync";

const { imports, savedItems, itemCollections } = schema;

export type ImportResult = {
  importId: number | null;
  status: "completed" | "duplicate" | "failed";
  filename: string;
  contentHash: string;
  itemsFound: number;
  itemsAdded: number;
  itemsUpdated: number;
  itemsSkipped: number;
  message: string;
};

function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function syncEmbeddingsAfterImport(
  importId: number,
  changedIds: number[],
): Promise<string> {
  try {
    const result = await syncItemEmbeddings(changedIds);
    return result.message;
  } catch (error) {
    const message = `Semantic indexing failed; imported data and keyword search are available. ${
      error instanceof Error ? error.message : "Unknown embedding error"
    }`;
    getDb()
      .update(imports)
      .set({ notes: message })
      .where(eq(imports.id, importId))
      .run();
    return message;
  }
}

function extractJsonFilesFromZip(buffer: Buffer): Array<{
  name: string;
  content: string;
}> {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const files: Array<{ name: string; content: string }> = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, "/");
    if (!name.toLowerCase().endsWith(".json")) continue;
    // Skip Mac metadata
    if (name.includes("__MACOSX") || name.split("/").pop()?.startsWith(".")) {
      continue;
    }
    try {
      files.push({
        name,
        content: entry.getData().toString("utf8"),
      });
    } catch {
      // Skip unreadable entries
    }
  }

  return files;
}

export async function importExportArchive(
  buffer: Buffer,
  filename: string,
): Promise<ImportResult> {
  const db = getDb();
  const contentHash = hashBuffer(buffer);

  const prior = db
    .select()
    .from(imports)
    .where(
      and(
        eq(imports.contentHash, contentHash),
        eq(imports.status, "completed"),
      ),
    )
    .get();

  if (prior) {
    const duplicate = db
      .insert(imports)
      .values({
        filename,
        contentHash,
        status: "duplicate",
        itemsFound: prior.itemsFound,
        itemsAdded: 0,
        itemsUpdated: 0,
        itemsSkipped: prior.itemsFound,
        notes: `Identical to import #${prior.id}`,
      })
      .returning()
      .get();

    return {
      importId: duplicate.id,
      status: "duplicate",
      filename,
      contentHash,
      itemsFound: prior.itemsFound,
      itemsAdded: 0,
      itemsUpdated: 0,
      itemsSkipped: prior.itemsFound,
      message: `This file was already imported (#${prior.id}). No changes made.`,
    };
  }

  let files: Array<{ name: string; content: string }>;
  try {
    files = extractJsonFilesFromZip(buffer);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to read zip archive";
    const failed = db
      .insert(imports)
      .values({
        filename,
        contentHash,
        status: "failed",
        error: message,
      })
      .returning()
      .get();

    return {
      importId: failed.id,
      status: "failed",
      filename,
      contentHash,
      itemsFound: 0,
      itemsAdded: 0,
      itemsUpdated: 0,
      itemsSkipped: 0,
      message,
    };
  }

  // Also accept a single JSON payload disguised as .json upload wrapped earlier
  const items = parseExportJsonFiles(files);

  if (items.length === 0) {
    const failed = db
      .insert(imports)
      .values({
        filename,
        contentHash,
        status: "failed",
        error:
          "No saved posts/reels found. Ensure the zip is an Instagram data export (JSON) that includes saved activity.",
        itemsFound: 0,
      })
      .returning()
      .get();

    return {
      importId: failed.id,
      status: "failed",
      filename,
      contentHash,
      itemsFound: 0,
      itemsAdded: 0,
      itemsUpdated: 0,
      itemsSkipped: 0,
      message: failed.error ?? "No saved items found",
    };
  }

  const draft = db
    .insert(imports)
    .values({
      filename,
      contentHash,
      status: "completed",
      itemsFound: items.length,
    })
    .returning()
    .get();

  try {
    const result = db.transaction((tx) => {
      // Use the same connection via getDb inside helpers — better-sqlite3
      // transactions need ops on the same Database. drizzle transaction callback
      // provides tx; reimplement with tx for correctness.
      return applyParsedItemsWithTx(tx, draft.id, items);
    });

    db.update(imports)
      .set({
        itemsAdded: result.added,
        itemsUpdated: result.updated,
        itemsSkipped: result.skipped,
        status: "completed",
      })
      .where(eq(imports.id, draft.id))
      .run();

    const embeddingMessage = await syncEmbeddingsAfterImport(
      draft.id,
      result.changedIds,
    );

    return {
      importId: draft.id,
      status: "completed",
      filename,
      contentHash,
      itemsFound: items.length,
      itemsAdded: result.added,
      itemsUpdated: result.updated,
      itemsSkipped: result.skipped,
      message: `Imported ${result.added} new, updated ${result.updated}, unchanged ${result.skipped}. ${embeddingMessage}`,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Import failed unexpectedly";
    db.update(imports)
      .set({ status: "failed", error: message })
      .where(eq(imports.id, draft.id))
      .run();

    return {
      importId: draft.id,
      status: "failed",
      filename,
      contentHash,
      itemsFound: items.length,
      itemsAdded: 0,
      itemsUpdated: 0,
      itemsSkipped: 0,
      message,
    };
  }
}

type DbTx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

function applyParsedItemsWithTx(
  tx: DbTx,
  importId: number,
  items: ParsedSavedItem[],
) {
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const changedIds: number[] = [];
  const sqlite = getSqlite();

  for (const item of items) {
    const existing = tx
      .select()
      .from(savedItems)
      .where(eq(savedItems.mediaKey, item.mediaKey))
      .get();

    if (!existing) {
      const inserted = tx
        .insert(savedItems)
        .values({
          mediaKey: item.mediaKey,
          href: item.href,
          shortcode: item.shortcode,
          mediaType: item.mediaType,
          authorUsername: item.authorUsername,
          savedAt: item.savedAt,
          firstSeenImportId: importId,
          lastSeenImportId: importId,
        })
        .returning({ id: savedItems.id })
        .get();

      const collections: string[] = [];
      for (const name of item.collections) {
        const trimmed = name.trim();
        if (!trimmed) continue;
        collections.push(trimmed);
        tx.insert(itemCollections)
          .values({ itemId: inserted.id, collectionName: trimmed })
          .onConflictDoNothing()
          .run();
      }

      upsertItemFts(
        inserted.id,
        {
          authorUsername: item.authorUsername,
          shortcode: item.shortcode,
          mediaKey: item.mediaKey,
          mediaType: item.mediaType,
          collections,
        },
        sqlite,
      );

      changedIds.push(inserted.id);
      added += 1;
      continue;
    }

    const shouldUpdateSavedAt =
      item.savedAt &&
      (!existing.savedAt || item.savedAt.getTime() > existing.savedAt.getTime());
    const shouldUpdateAuthor =
      !!item.authorUsername &&
      item.authorUsername !== existing.authorUsername;
    const shouldUpdateType =
      item.mediaType !== "unknown" && item.mediaType !== existing.mediaType;
    const shouldUpdateHref = item.href !== existing.href;

    const existingCollections = tx
      .select()
      .from(itemCollections)
      .where(eq(itemCollections.itemId, existing.id))
      .all()
      .map((row) => row.collectionName);

    const newCollections = item.collections.filter(
      (name) => !existingCollections.includes(name),
    );

    const hasChanges =
      shouldUpdateSavedAt ||
      shouldUpdateAuthor ||
      shouldUpdateType ||
      shouldUpdateHref ||
      newCollections.length > 0;

    const nextAuthor = shouldUpdateAuthor
      ? item.authorUsername
      : existing.authorUsername;
    const nextType = shouldUpdateType ? item.mediaType : existing.mediaType;
    const nextHref = shouldUpdateHref ? item.href : existing.href;

    tx.update(savedItems)
      .set({
        lastSeenImportId: importId,
        href: nextHref,
        authorUsername: nextAuthor,
        mediaType: nextType,
        savedAt: shouldUpdateSavedAt ? item.savedAt : existing.savedAt,
        updatedAt: new Date(),
      })
      .where(eq(savedItems.id, existing.id))
      .run();

    for (const name of newCollections) {
      tx.insert(itemCollections)
        .values({ itemId: existing.id, collectionName: name })
        .onConflictDoNothing()
        .run();
    }

    if (hasChanges) {
      upsertItemFts(
        existing.id,
        {
          authorUsername: nextAuthor,
          shortcode: existing.shortcode,
          mediaKey: existing.mediaKey,
          mediaType: nextType,
          collections: [...existingCollections, ...newCollections],
        },
        sqlite,
      );
      changedIds.push(existing.id);
      updated += 1;
    } else skipped += 1;
  }

  return { added, updated, skipped, changedIds };
}

export async function importExportJson(
  content: string,
  filename: string,
): Promise<ImportResult> {
  // Wrap a lone JSON file into the same pipeline via a synthetic zip-like path
  const buffer = Buffer.from(content, "utf8");
  const contentHash = hashBuffer(buffer);
  const db = getDb();

  const prior = db
    .select()
    .from(imports)
    .where(
      and(
        eq(imports.contentHash, contentHash),
        eq(imports.status, "completed"),
      ),
    )
    .get();

  if (prior) {
    const duplicate = db
      .insert(imports)
      .values({
        filename,
        contentHash,
        status: "duplicate",
        itemsFound: prior.itemsFound,
        itemsAdded: 0,
        itemsUpdated: 0,
        itemsSkipped: prior.itemsFound,
        notes: `Identical to import #${prior.id}`,
      })
      .returning()
      .get();

    return {
      importId: duplicate.id,
      status: "duplicate",
      filename,
      contentHash,
      itemsFound: prior.itemsFound,
      itemsAdded: 0,
      itemsUpdated: 0,
      itemsSkipped: prior.itemsFound,
      message: `This file was already imported (#${prior.id}). No changes made.`,
    };
  }

  const items = parseExportJsonFiles([{ name: filename, content }]);
  if (items.length === 0) {
    const failed = db
      .insert(imports)
      .values({
        filename,
        contentHash,
        status: "failed",
        error: "No saved posts/reels found in JSON.",
      })
      .returning()
      .get();

    return {
      importId: failed.id,
      status: "failed",
      filename,
      contentHash,
      itemsFound: 0,
      itemsAdded: 0,
      itemsUpdated: 0,
      itemsSkipped: 0,
      message: failed.error ?? "No saved items found",
    };
  }

  const draft = db
    .insert(imports)
    .values({
      filename,
      contentHash,
      status: "completed",
      itemsFound: items.length,
    })
    .returning()
    .get();

  try {
    const result = db.transaction((tx) =>
      applyParsedItemsWithTx(tx, draft.id, items),
    );

    db.update(imports)
      .set({
        itemsAdded: result.added,
        itemsUpdated: result.updated,
        itemsSkipped: result.skipped,
      })
      .where(eq(imports.id, draft.id))
      .run();

    const embeddingMessage = await syncEmbeddingsAfterImport(
      draft.id,
      result.changedIds,
    );

    return {
      importId: draft.id,
      status: "completed",
      filename,
      contentHash,
      itemsFound: items.length,
      itemsAdded: result.added,
      itemsUpdated: result.updated,
      itemsSkipped: result.skipped,
      message: `Imported ${result.added} new, updated ${result.updated}, unchanged ${result.skipped}. ${embeddingMessage}`,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Import failed unexpectedly";
    db.update(imports)
      .set({ status: "failed", error: message })
      .where(eq(imports.id, draft.id))
      .run();

    return {
      importId: draft.id,
      status: "failed",
      filename,
      contentHash,
      itemsFound: items.length,
      itemsAdded: 0,
      itemsUpdated: 0,
      itemsSkipped: 0,
      message,
    };
  }
}
