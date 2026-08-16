import { eq } from "drizzle-orm";
import { getDb, getSqlite, schema } from "../db";
import { IMPORT_WRITE_BATCH_SIZE } from "../import-limits";
import { upsertLikedItemFts } from "../likes-fts";
import type { ParsedLikedItem, ParsedSavedItem } from "../parse-export";
import { upsertItemFts } from "../search/sync";
import type { FileSchemaCatalogEntry } from "../json-schema-infer";
import { emitProgress, throwIfCancelled, yieldToEventLoop } from "./progress";
import type { ImportRunOptions } from "./types";

const { savedItems, itemCollections, importSchemas, likedItems } = schema;

export function persistImportSchemas(
  importId: number,
  catalog: FileSchemaCatalogEntry[],
) {
  const db = getDb();
  db.delete(importSchemas).where(eq(importSchemas.importId, importId)).run();

  for (const entry of catalog) {
    db.insert(importSchemas)
      .values({
        importId,
        filePath: entry.filePath,
        byteSize: entry.byteSize,
        truncatedRead: entry.truncatedRead,
        topLevelType: entry.topLevelType,
        schemaJson: JSON.stringify({
          schema: entry.schema,
          parseError: entry.parseError ?? null,
        }),
      })
      .run();
  }
}

type DbTx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

function applyOneParsedItem(tx: DbTx, importId: number, item: ParsedSavedItem) {
  const sqlite = getSqlite();
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

    return { kind: "added" as const, id: inserted.id };
  }

  const shouldUpdateSavedAt =
    item.savedAt &&
    (!existing.savedAt || item.savedAt.getTime() > existing.savedAt.getTime());
  // Backfill missing author, or replace when the export supplies a different one.
  const shouldUpdateAuthor =
    !!item.authorUsername &&
    (!existing.authorUsername ||
      item.authorUsername !== existing.authorUsername);
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
    return { kind: "updated" as const, id: existing.id };
  }

  return { kind: "skipped" as const, id: existing.id };
}

function applyOneLikedItem(tx: DbTx, importId: number, item: ParsedLikedItem) {
  const sqlite = getSqlite();
  const existing = tx
    .select()
    .from(likedItems)
    .where(eq(likedItems.mediaKey, item.mediaKey))
    .get();

  if (!existing) {
    const inserted = tx
      .insert(likedItems)
      .values({
        mediaKey: item.mediaKey,
        href: item.href,
        shortcode: item.shortcode,
        mediaType: item.mediaType,
        authorUsername: item.authorUsername,
        likedAt: item.likedAt,
        source: item.source,
        firstSeenImportId: importId,
        lastSeenImportId: importId,
      })
      .returning({ id: likedItems.id })
      .get();

    upsertLikedItemFts(
      inserted.id,
      {
        authorUsername: item.authorUsername,
        shortcode: item.shortcode,
        mediaKey: item.mediaKey,
        mediaType: item.mediaType,
        source: item.source,
      },
      sqlite,
    );

    return { kind: "added" as const, id: inserted.id };
  }

  const shouldUpdateLikedAt =
    item.likedAt &&
    (!existing.likedAt || item.likedAt.getTime() > existing.likedAt.getTime());
  const shouldUpdateAuthor =
    !!item.authorUsername &&
    (!existing.authorUsername ||
      item.authorUsername !== existing.authorUsername);
  const shouldUpdateType =
    item.mediaType !== "unknown" && item.mediaType !== existing.mediaType;
  const shouldUpdateHref = item.href !== existing.href;
  const shouldUpdateSource = item.source !== existing.source;

  const hasChanges =
    shouldUpdateLikedAt ||
    shouldUpdateAuthor ||
    shouldUpdateType ||
    shouldUpdateHref ||
    shouldUpdateSource;

  const nextAuthor = shouldUpdateAuthor
    ? item.authorUsername
    : existing.authorUsername;
  const nextType = shouldUpdateType ? item.mediaType : existing.mediaType;
  const nextHref = shouldUpdateHref ? item.href : existing.href;
  const nextSource = shouldUpdateSource ? item.source : existing.source;

  tx.update(likedItems)
    .set({
      lastSeenImportId: importId,
      href: nextHref,
      authorUsername: nextAuthor,
      mediaType: nextType,
      source: nextSource,
      likedAt: shouldUpdateLikedAt ? item.likedAt : existing.likedAt,
      updatedAt: new Date(),
    })
    .where(eq(likedItems.id, existing.id))
    .run();

  if (hasChanges) {
    upsertLikedItemFts(
      existing.id,
      {
        authorUsername: nextAuthor,
        shortcode: existing.shortcode,
        mediaKey: existing.mediaKey,
        mediaType: nextType,
        source: nextSource,
      },
      sqlite,
    );
    return { kind: "updated" as const, id: existing.id };
  }

  return { kind: "skipped" as const, id: existing.id };
}

export async function applyParsedItems(
  importId: number,
  items: ParsedSavedItem[],
  options?: ImportRunOptions,
) {
  const db = getDb();
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const changedIds: number[] = [];
  const total = items.length;
  const batchSize = Math.max(1, IMPORT_WRITE_BATCH_SIZE);

  await emitProgress(options?.onProgress, {
    phase: "writing",
    processed: 0,
    total: Math.max(1, total),
    message: `Writing ${total} item${total === 1 ? "" : "s"}…`,
    details: {
      importId,
      itemsParsed: total,
      itemsAdded: 0,
      itemsUpdated: 0,
      itemsSkipped: 0,
    },
  });

  for (let i = 0; i < items.length; i += batchSize) {
    throwIfCancelled(options?.shouldCancel);
    const batch = items.slice(i, i + batchSize);
    const outcomes = db.transaction((tx) =>
      batch.map((item) => applyOneParsedItem(tx, importId, item)),
    );

    for (const outcome of outcomes) {
      if (outcome.kind === "added") {
        added += 1;
        changedIds.push(outcome.id);
      } else if (outcome.kind === "updated") {
        updated += 1;
        changedIds.push(outcome.id);
      } else {
        skipped += 1;
      }
    }

    const processed = Math.min(i + batch.length, total);
    if (processed === total || processed % batchSize === 0 || processed % 20 === 0) {
      await emitProgress(options?.onProgress, {
        phase: "writing",
        processed,
        total: Math.max(1, total),
        message: `Writing items… ${processed}/${total} (added ${added}, updated ${updated}, skipped ${skipped})`,
        details: {
          importId,
          itemsParsed: total,
          itemsAdded: added,
          itemsUpdated: updated,
          itemsSkipped: skipped,
        },
      });
    }
    await yieldToEventLoop();
  }

  return { added, updated, skipped, changedIds };
}

export async function applyLikedItems(
  importId: number,
  items: ParsedLikedItem[],
  options?: ImportRunOptions,
) {
  const db = getDb();
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const changedIds: number[] = [];
  const total = items.length;
  const batchSize = Math.max(1, IMPORT_WRITE_BATCH_SIZE);

  if (total === 0) {
    return { added: 0, updated: 0, skipped: 0, changedIds };
  }

  await emitProgress(options?.onProgress, {
    phase: "writing",
    processed: 0,
    total: Math.max(1, total),
    message: `Writing ${total} liked item${total === 1 ? "" : "s"}…`,
    details: {
      importId,
      likesParsed: total,
      likesAdded: 0,
      likesUpdated: 0,
      likesSkipped: 0,
    },
  });

  for (let i = 0; i < items.length; i += batchSize) {
    throwIfCancelled(options?.shouldCancel);
    const batch = items.slice(i, i + batchSize);
    const outcomes = db.transaction((tx) =>
      batch.map((item) => applyOneLikedItem(tx, importId, item)),
    );

    for (const outcome of outcomes) {
      if (outcome.kind === "added") {
        added += 1;
        changedIds.push(outcome.id);
      } else if (outcome.kind === "updated") {
        updated += 1;
        changedIds.push(outcome.id);
      } else {
        skipped += 1;
      }
    }

    const processed = Math.min(i + batch.length, total);
    if (
      processed === total ||
      processed % batchSize === 0 ||
      processed % 50 === 0
    ) {
      await emitProgress(options?.onProgress, {
        phase: "writing",
        processed,
        total: Math.max(1, total),
        message: `Writing likes… ${processed}/${total} (added ${added}, updated ${updated}, skipped ${skipped})`,
        details: {
          importId,
          likesParsed: total,
          likesAdded: added,
          likesUpdated: updated,
          likesSkipped: skipped,
        },
      });
    }
    await yieldToEventLoop();
  }

  return { added, updated, skipped, changedIds };
}
