import { eq } from "drizzle-orm";
import { getDb, getSqlite, schema } from "../db";
import { IMPORT_WRITE_BATCH_SIZE } from "../import-limits";
import type { ParsedLikedItem, ParsedSavedItem } from "../parse-export";
import { upsertItemFts, upsertLikedItemFts } from "../search/sync";
import type { FileSchemaCatalogEntry } from "../json-schema-infer";
import { emitProgress, throwIfCancelled, yieldToEventLoop } from "./progress";
import type { ImportRunOptions } from "./types";

const { media, saved, itemCollections, importSchemas, liked } = schema;

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
  const existingMedia = tx
    .select()
    .from(media)
    .where(eq(media.mediaKey, item.mediaKey))
    .get();
  const mediaId = existingMedia
    ? existingMedia.id
    : tx
      .insert(media)
      .values({
        mediaKey: item.mediaKey,
        href: item.href,
        shortcode: item.shortcode,
        mediaType: item.mediaType,
        authorUsername: item.authorUsername,
      })
      .returning({ id: media.id })
      .get().id;

  const currentMedia = existingMedia ?? {
    id: mediaId,
    mediaKey: item.mediaKey,
    href: item.href,
    shortcode: item.shortcode,
    mediaType: item.mediaType,
    authorUsername: item.authorUsername,
  };
  const shouldUpdateAuthor =
    !!item.authorUsername &&
    (!currentMedia.authorUsername ||
      item.authorUsername !== currentMedia.authorUsername);
  const shouldUpdateType =
    item.mediaType !== "unknown" && item.mediaType !== currentMedia.mediaType;
  const shouldUpdateHref = item.href !== currentMedia.href;
  if (existingMedia && (shouldUpdateAuthor || shouldUpdateType || shouldUpdateHref)) {
    tx.update(media)
      .set({
        href: shouldUpdateHref ? item.href : currentMedia.href,
        authorUsername: shouldUpdateAuthor
          ? item.authorUsername
          : currentMedia.authorUsername,
        mediaType: shouldUpdateType ? item.mediaType : currentMedia.mediaType,
        updatedAt: new Date(),
      })
      .where(eq(media.id, mediaId))
      .run();
  }

  const existing = tx.select().from(saved).where(eq(saved.mediaId, mediaId)).get();
  if (!existing) {
    tx.insert(saved)
      .values({
        mediaId,
        savedAt: item.savedAt,
        firstSeenImportId: importId,
        lastSeenImportId: importId,
      })
      .run();
  } else {
    const shouldUpdateSavedAt =
      item.savedAt &&
      (!existing.savedAt || item.savedAt.getTime() > existing.savedAt.getTime());
    tx.update(saved)
      .set({
        lastSeenImportId: importId,
        savedAt: shouldUpdateSavedAt ? item.savedAt : existing.savedAt,
        updatedAt: new Date(),
      })
      .where(eq(saved.mediaId, mediaId))
      .run();
  }
  const existingCollections = tx
    .select()
    .from(itemCollections)
    .where(eq(itemCollections.itemId, mediaId))
    .all()
    .map((row) => row.collectionName);
  const newCollections = item.collections
    .map((name) => name.trim())
    .filter((name) => name && !existingCollections.includes(name));
  for (const name of newCollections) {
    tx.insert(itemCollections)
      .values({ itemId: mediaId, collectionName: name })
      .onConflictDoNothing()
      .run();
  }
  const nextAuthor = shouldUpdateAuthor ? item.authorUsername : currentMedia.authorUsername;
  const nextType = shouldUpdateType ? item.mediaType : currentMedia.mediaType;
  upsertItemFts(mediaId, {
    authorUsername: nextAuthor,
    shortcode: currentMedia.shortcode,
    mediaKey: currentMedia.mediaKey,
    mediaType: nextType,
    collections: [...existingCollections, ...newCollections],
  }, sqlite);
  const changed = !existing || !existingMedia || shouldUpdateAuthor ||
    shouldUpdateType || shouldUpdateHref || newCollections.length > 0 ||
    Boolean(item.savedAt && (!existing?.savedAt || item.savedAt > existing.savedAt));
  return { kind: changed ? (existing ? "updated" as const : "added" as const) : "skipped" as const, id: mediaId };
}

function applyOneLikedItem(tx: DbTx, importId: number, item: ParsedLikedItem) {
  const sqlite = getSqlite();
  if (
    item.source === "liked_comments" ||
    item.mediaType === "comment" ||
    item.mediaKey.startsWith("comment:")
  ) {
    return { kind: "skipped" as const, id: null };
  }
  const mediaType = item.mediaType as Exclude<typeof item.mediaType, "comment">;
  const existingMedia = tx
    .select()
    .from(media)
    .where(eq(media.mediaKey, item.mediaKey))
    .get();
  const mediaId = existingMedia
    ? existingMedia.id
    : tx.insert(media)
      .values({
        mediaKey: item.mediaKey,
        href: item.href,
        shortcode: item.shortcode,
        mediaType,
        authorUsername: item.authorUsername,
      })
      .returning({ id: media.id }).get().id;
  const currentMedia = existingMedia ?? {
    id: mediaId, mediaKey: item.mediaKey, href: item.href,
    shortcode: item.shortcode, mediaType,
    authorUsername: item.authorUsername,
  };
  const shouldUpdateAuthor =
    !!item.authorUsername &&
    (!currentMedia.authorUsername ||
      item.authorUsername !== currentMedia.authorUsername);
  const shouldUpdateType =
    mediaType !== "unknown" && mediaType !== currentMedia.mediaType;
  const shouldUpdateHref = item.href !== currentMedia.href;
  if (existingMedia && (shouldUpdateAuthor || shouldUpdateType || shouldUpdateHref)) {
    tx.update(media).set({
      href: shouldUpdateHref ? item.href : currentMedia.href,
      authorUsername: shouldUpdateAuthor ? item.authorUsername : currentMedia.authorUsername,
      mediaType: shouldUpdateType ? mediaType : currentMedia.mediaType,
      updatedAt: new Date(),
    }).where(eq(media.id, mediaId)).run();
  }
  const existing = tx.select().from(liked).where(eq(liked.mediaId, mediaId)).get();
  const shouldUpdateLikedAt = Boolean(item.likedAt &&
    (!existing?.likedAt || item.likedAt.getTime() > existing.likedAt.getTime()));
  const shouldUpdateSource = Boolean(existing && item.source !== existing.source);
  if (!existing) {
    tx.insert(liked).values({
      mediaId, likedAt: item.likedAt, source: item.source as "liked_posts" | "story_likes",
      firstSeenImportId: importId, lastSeenImportId: importId,
    }).run();
  } else {
    tx.update(liked).set({
      lastSeenImportId: importId,
      likedAt: shouldUpdateLikedAt ? item.likedAt : existing.likedAt,
      source: item.source as "liked_posts" | "story_likes",
      updatedAt: new Date(),
    }).where(eq(liked.mediaId, mediaId)).run();
  }
  const nextAuthor = shouldUpdateAuthor ? item.authorUsername : currentMedia.authorUsername;
  const nextType = shouldUpdateType ? mediaType : currentMedia.mediaType;
  upsertLikedItemFts(mediaId, {
    authorUsername: nextAuthor, shortcode: currentMedia.shortcode,
    mediaKey: currentMedia.mediaKey, mediaType: nextType,
    source: item.source,
  }, sqlite);
  const changed = !existing || !existingMedia || shouldUpdateLikedAt ||
    shouldUpdateSource || shouldUpdateAuthor || shouldUpdateType || shouldUpdateHref;
  return { kind: changed ? (existing ? "updated" as const : "added" as const) : "skipped" as const, id: mediaId };
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
