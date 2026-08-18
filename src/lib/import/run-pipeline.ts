import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import {
  buildImportLogFromItems,
  serializeImportLog,
  type ImportLog,
} from "../import-log";
import {
  type ParsedLikedItem,
  type ParsedSavedItem,
} from "../parse-export";
import type { FileSchemaCatalogEntry } from "../json-schema-infer";
import {
  hashBuffer,
  hashZipSource,
} from "./zip-extract";
import {
  applyLikedItems,
  applyParsedItems,
  persistImportSchemas,
} from "./write-batches";
import {
  catalogSchemasWithProgress,
  parseExportJsonFilesWithProgress,
  parseLikedExportJsonFilesWithProgress,
  syncEmbeddingsAfterImport,
} from "./run-helpers";
import {
  formatPartialImportMessage,
} from "./partial-accounting";
import { rollbackImportInserts } from "./rollback-partial";
import { emitProgress, throwIfCancelled } from "./progress";
import {
  processZipExportStreaming,
  type StreamedZipExport,
} from "./stream-zip";
import {
  ImportCancelledError,
  type ImportResult,
  type ImportRunOptions,
  type ZipImportSource,
} from "./types";

const { imports } = schema;

async function finishSuccessfulImport(args: {
  draftId: number;
  filename: string;
  contentHash: string;
  items: ParsedSavedItem[];
  liked: ParsedLikedItem[];
  importLog: ImportLog;
  schemaCatalog: FileSchemaCatalogEntry[];
  isDuplicate: boolean;
  priorId: number | null;
  options?: ImportRunOptions;
}): Promise<ImportResult> {
  const {
    draftId,
    filename,
    contentHash,
    items,
    liked,
    importLog,
    schemaCatalog,
    isDuplicate,
    priorId,
    options,
  } = args;
  const db = getDb();

  try {
    const result =
      items.length > 0
        ? await applyParsedItems(draftId, items, options)
        : { added: 0, updated: 0, skipped: 0, changedIds: [] as number[] };

    const likesResult = await applyLikedItems(draftId, liked, options);

    persistImportSchemas(draftId, schemaCatalog);

    const completedLog: ImportLog = {
      ...importLog,
      likesAdded: likesResult.added,
      likesUpdated: likesResult.updated,
      likesSkipped: likesResult.skipped,
      warnings: [
        ...importLog.warnings,
        ...(isDuplicate && priorId
          ? [`Identical file to import #${priorId}; metadata refreshed.`]
          : []),
        ...(liked.length > 0
          ? [
              `Likes: ${likesResult.added} added, ${likesResult.updated} updated, ${likesResult.skipped} unchanged.`,
            ]
          : []),
      ],
    };

    db.update(imports)
      .set({
        itemsAdded: result.added,
        itemsUpdated: result.updated,
        itemsSkipped: result.skipped,
        status: isDuplicate ? "duplicate" : "completed",
        notes: serializeImportLog(completedLog),
      })
      .where(eq(imports.id, draftId))
      .run();

    const embeddingMessage =
      result.changedIds.length > 0
        ? await syncEmbeddingsAfterImport(
            draftId,
            result.changedIds,
            options,
            "saves",
          )
        : "No saved items to embed.";

    const likesEmbeddingMessage =
      likesResult.changedIds.length > 0
        ? await syncEmbeddingsAfterImport(
            draftId,
            likesResult.changedIds,
            options,
            "likes",
          )
        : liked.length > 0
          ? " No liked items needed embedding."
          : "";

    const likesSummary =
      liked.length > 0
        ? ` Likes: ${likesResult.added} new, ${likesResult.updated} updated, ${likesResult.skipped} unchanged.`
        : "";

    const message = isDuplicate
      ? `Same file as import #${priorId}. Refreshed metadata for ${result.updated} saves (${result.skipped} unchanged).${likesSummary} ${embeddingMessage}${likesEmbeddingMessage}`
      : `Imported ${result.added} new saves, updated ${result.updated}, unchanged ${result.skipped}.${likesSummary} ${embeddingMessage}${likesEmbeddingMessage}`;

    await emitProgress(options?.onProgress, {
      phase: "completed",
      processed: items.length + liked.length,
      total: Math.max(1, items.length + liked.length),
      message,
      details: {
        importId: draftId,
        itemsParsed: items.length,
        likesParsed: liked.length,
        itemsAdded: result.added,
        itemsUpdated: result.updated,
        itemsSkipped: result.skipped,
        likesAdded: likesResult.added,
        likesUpdated: likesResult.updated,
        likesSkipped: likesResult.skipped,
      },
    });

    return {
      importId: draftId,
      status: isDuplicate ? "duplicate" : "completed",
      filename,
      contentHash,
      itemsFound: items.length,
      itemsAdded: result.added,
      itemsUpdated: result.updated,
      itemsSkipped: result.skipped,
      likesFound: liked.length,
      likesAdded: likesResult.added,
      likesUpdated: likesResult.updated,
      likesSkipped: likesResult.skipped,
      message,
      log: completedLog,
    };
  } catch (error) {
    // Batches commit as they go — roll back inserts so aborted imports do not
    // leave durable new catalog rows. Residual last_seen-only updates may remain.
    const rollback = rollbackImportInserts(draftId);
    const residual = rollback.after;
    const baseMessage =
      error instanceof ImportCancelledError
        ? "Import cancelled"
        : error instanceof Error
          ? error.message
          : "Import failed unexpectedly";
    const message = formatPartialImportMessage(baseMessage, residual, {
      rolledBackSaves: rollback.savesDeleted,
      rolledBackLikes: rollback.likesDeleted,
    });

    db.update(imports)
      .set({
        status: "failed",
        error: message,
        itemsAdded: residual.itemsAdded,
        itemsUpdated: residual.itemsUpdated,
        itemsSkipped: 0,
      })
      .where(eq(imports.id, draftId))
      .run();

    await emitProgress(options?.onProgress, {
      phase: "failed",
      processed:
        residual.itemsAdded +
        residual.itemsUpdated +
        residual.likesAdded +
        residual.likesUpdated,
      total: Math.max(1, items.length + liked.length),
      message,
      details: {
        importId: draftId,
        itemsParsed: items.length,
        likesParsed: liked.length,
        itemsAdded: residual.itemsAdded,
        itemsUpdated: residual.itemsUpdated,
        likesAdded: residual.likesAdded,
        likesUpdated: residual.likesUpdated,
      },
    });

    if (error instanceof ImportCancelledError) {
      // Preserve cancel semantics for the job runner while still recording counts.
      throw new ImportCancelledError(message);
    }

    return {
      importId: draftId,
      status: "failed",
      filename,
      contentHash,
      itemsFound: items.length,
      itemsAdded: residual.itemsAdded,
      itemsUpdated: residual.itemsUpdated,
      itemsSkipped: 0,
      likesFound: liked.length,
      likesAdded: residual.likesAdded,
      likesUpdated: residual.likesUpdated,
      likesSkipped: 0,
      message,
    };
  }
}

export async function importExportArchive(
  source: ZipImportSource,
  filename: string,
  options?: ImportRunOptions,
): Promise<ImportResult> {
  const db = getDb();
  const contentHash =
    options?.contentHash ?? (await hashZipSource(source));

  await emitProgress(options?.onProgress, {
    phase: "received",
    processed: 0,
    total: 1,
    message: `Received ${filename}`,
  });
  throwIfCancelled(options?.shouldCancel);

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

  let streamed: StreamedZipExport;
  try {
    streamed = await processZipExportStreaming(source, options);
  } catch (error) {
    if (error instanceof ImportCancelledError) throw error;
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

    await emitProgress(options?.onProgress, {
      phase: "failed",
      processed: 0,
      total: 1,
      message,
      details: { importId: failed.id },
    });

    return {
      importId: failed.id,
      status: "failed",
      filename,
      contentHash,
      itemsFound: 0,
      itemsAdded: 0,
      itemsUpdated: 0,
      itemsSkipped: 0,
      likesFound: 0,
      likesAdded: 0,
      likesUpdated: 0,
      likesSkipped: 0,
      message,
    };
  }

  const { schemaCatalog, parsed, likedParsed, fileNames } = streamed;
  const items = parsed.items;
  const liked = likedParsed.items;
  const importLog = buildImportLogFromItems(
    fileNames.map((name) => ({ name })),
    parsed.savedJsonFiles,
    items,
    parsed.warnings,
    {
      likedJsonFiles: likedParsed.likedJsonFiles,
      items: liked,
      warnings: likedParsed.warnings,
    },
  );

  if (items.length === 0 && liked.length === 0) {
    const failed = db
      .insert(imports)
      .values({
        filename,
        contentHash,
        status: "failed",
        error:
          "No saved or liked posts found. Ensure the zip is an Instagram data export (JSON) that includes saved and/or likes activity.",
        itemsFound: 0,
      })
      .returning()
      .get();

    // Still keep schema catalog so the explorer can show what was in the zip.
    try {
      persistImportSchemas(failed.id, schemaCatalog);
    } catch {
      // non-fatal
    }

    await emitProgress(options?.onProgress, {
      phase: "failed",
      processed: 0,
      total: 1,
      message: failed.error ?? "No saved or liked items found",
      details: {
        importId: failed.id,
        schemasInferred: schemaCatalog.length,
        jsonFiles: fileNames.length,
      },
    });

    return {
      importId: failed.id,
      status: "failed",
      filename,
      contentHash,
      itemsFound: 0,
      itemsAdded: 0,
      itemsUpdated: 0,
      itemsSkipped: 0,
      likesFound: 0,
      likesAdded: 0,
      likesUpdated: 0,
      likesSkipped: 0,
      message: failed.error ?? "No saved or liked items found",
    };
  }

  const isDuplicate = Boolean(prior);
  const draft = db
    .insert(imports)
    .values({
      filename,
      contentHash,
      status: isDuplicate ? "duplicate" : "completed",
      itemsFound: items.length,
      notes: serializeImportLog(importLog),
    })
    .returning()
    .get();

  return finishSuccessfulImport({
    draftId: draft.id,
    filename,
    contentHash,
    items,
    liked,
    importLog,
    schemaCatalog,
    isDuplicate,
    priorId: prior?.id ?? null,
    options,
  });
}

export async function importExportJson(
  content: string,
  filename: string,
  options?: ImportRunOptions,
): Promise<ImportResult> {
  const buffer = Buffer.from(content, "utf8");
  const contentHash = options?.contentHash ?? hashBuffer(buffer);
  const db = getDb();

  await emitProgress(options?.onProgress, {
    phase: "received",
    processed: 0,
    total: 1,
    message: `Received ${filename}`,
  });
  throwIfCancelled(options?.shouldCancel);

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

  const jsonFiles = [{ name: filename, content, byteSize: buffer.byteLength }];
  const schemaCatalog = await catalogSchemasWithProgress(jsonFiles, options);
  const parsed = await parseExportJsonFilesWithProgress(jsonFiles, options);
  const likedParsed = await parseLikedExportJsonFilesWithProgress(
    jsonFiles,
    options,
  );
  const items = parsed.items;
  const liked = likedParsed.items;
  const importLog = buildImportLogFromItems(
    [{ name: filename }],
    parsed.savedJsonFiles,
    items,
    parsed.warnings,
    {
      likedJsonFiles: likedParsed.likedJsonFiles,
      items: liked,
      warnings: likedParsed.warnings,
    },
  );

  if (items.length === 0 && liked.length === 0) {
    const failed = db
      .insert(imports)
      .values({
        filename,
        contentHash,
        status: "failed",
        error: "No saved or liked posts found in JSON.",
      })
      .returning()
      .get();

    try {
      persistImportSchemas(failed.id, schemaCatalog);
    } catch {
      // non-fatal
    }

    await emitProgress(options?.onProgress, {
      phase: "failed",
      processed: 0,
      total: 1,
      message: failed.error ?? "No saved or liked items found",
      details: { importId: failed.id },
    });

    return {
      importId: failed.id,
      status: "failed",
      filename,
      contentHash,
      itemsFound: 0,
      itemsAdded: 0,
      itemsUpdated: 0,
      itemsSkipped: 0,
      likesFound: 0,
      likesAdded: 0,
      likesUpdated: 0,
      likesSkipped: 0,
      message: failed.error ?? "No saved or liked items found",
    };
  }

  const isDuplicate = Boolean(prior);
  const draft = db
    .insert(imports)
    .values({
      filename,
      contentHash,
      status: isDuplicate ? "duplicate" : "completed",
      itemsFound: items.length,
      notes: serializeImportLog(importLog),
    })
    .returning()
    .get();

  return finishSuccessfulImport({
    draftId: draft.id,
    filename,
    contentHash,
    items,
    liked,
    importLog,
    schemaCatalog,
    isDuplicate,
    priorId: prior?.id ?? null,
    options,
  });
}

