import { createHash } from "node:crypto";
import fs from "node:fs";
import { and, eq } from "drizzle-orm";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { getDb, getSqlite, schema } from "./db";
import {
  buildImportLogFromItems,
  serializeImportLog,
  type ImportLog,
} from "./import-log";
import {
  DEFAULT_IMPORT_ZIP_SAFETY_LIMITS,
  IMPORT_WRITE_BATCH_SIZE,
  importZipEntryTooLargeMessage,
  importZipExtractBudgetExceededMessage,
  type ImportZipSafetyLimits,
} from "./import-limits";
import {
  inferFileSchema,
  type FileSchemaCatalogEntry,
} from "./json-schema-infer";
import {
  accumulateExportJsonFile,
  accumulateLikedExportJsonFile,
  createLikesParseAccumulator,
  createSavesParseAccumulator,
  finalizeLikesParse,
  finalizeSavesParse,
  parseExportJsonFiles,
  parseLikedExportJsonFiles,
  type LikesParseResult,
  type ParsedLikedItem,
  type ParsedSavedItem,
  type ParseResult,
} from "./parse-export";
import { upsertLikedItemFts } from "./likes-fts";
import {
  syncItemEmbeddings,
  syncLikedItemEmbeddings,
  upsertItemFts,
} from "./search/sync";

/** Zip bytes in memory, or a spool/file path streamed via yauzl. */
export type ZipImportSource = Buffer | string;

const { imports, savedItems, itemCollections, importSchemas, likedItems } =
  schema;

export type ImportResult = {
  importId: number | null;
  status: "completed" | "duplicate" | "failed";
  filename: string;
  contentHash: string;
  itemsFound: number;
  itemsAdded: number;
  itemsUpdated: number;
  itemsSkipped: number;
  likesFound: number;
  likesAdded: number;
  likesUpdated: number;
  likesSkipped: number;
  message: string;
  log?: ImportLog;
};

export type ImportProgressPhase =
  | "queued"
  | "received"
  | "extracting"
  | "inferring_schemas"
  | "parsing_saves"
  | "parsing_likes"
  | "writing"
  | "indexing"
  | "completed"
  | "failed";

export type ImportProgressDetails = {
  filesScanned?: number;
  jsonFiles?: number;
  schemasInferred?: number;
  itemsParsed?: number;
  likesParsed?: number;
  itemsAdded?: number;
  itemsUpdated?: number;
  itemsSkipped?: number;
  likesAdded?: number;
  likesUpdated?: number;
  likesSkipped?: number;
  importId?: number | null;
};

export type ImportProgress = {
  phase: ImportProgressPhase;
  processed: number;
  total: number;
  message?: string;
  details?: ImportProgressDetails;
};

export type ImportRunOptions = {
  onProgress?: (progress: ImportProgress) => void | Promise<void>;
  shouldCancel?: () => boolean;
  /** Precomputed hash when the spool writer already hashed the bytes. */
  contentHash?: string;
  /**
   * Override zip extract safety caps (tests). Production uses
   * DEFAULT_IMPORT_ZIP_SAFETY_LIMITS from import-limits.
   */
  zipSafetyLimits?: Partial<ImportZipSafetyLimits>;
};

export class ImportCancelledError extends Error {
  constructor(message = "Import cancelled") {
    super(message);
    this.name = "ImportCancelledError";
  }
}

/** Fail-closed zip / extract safety violation (bomb, over-cap entry, budget). */
export class ImportZipSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportZipSafetyError";
  }
}

function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function hashZipSource(source: ZipImportSource): Promise<string> {
  if (typeof source === "string") return hashFile(source);
  return hashBuffer(source);
}

function openZipSource(source: ZipImportSource): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    const options = { lazyEntries: true, validateEntrySizes: true } as const;
    if (typeof source === "string") {
      yauzl.open(source, options, (err, zipfile) => {
        if (err || !zipfile) reject(err ?? new Error("Failed to open zip"));
        else resolve(zipfile);
      });
    } else {
      yauzl.fromBuffer(source, options, (err, zipfile) => {
        if (err || !zipfile) reject(err ?? new Error("Failed to open zip"));
        else resolve(zipfile);
      });
    }
  });
}

function isJsonZipEntryName(name: string): boolean {
  if (!name.toLowerCase().endsWith(".json")) return false;
  if (name.includes("__MACOSX") || name.split("/").pop()?.startsWith(".")) {
    return false;
  }
  return true;
}

function readZipEntryBuffer(
  zipfile: ZipFile,
  entry: Entry,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, readStream) => {
      if (err || !readStream) {
        reject(err ?? new Error("Failed to open zip entry stream"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;

      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        readStream.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      readStream.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > maxBytes) {
          fail(
            new ImportZipSafetyError(
              importZipEntryTooLargeMessage(
                entry.fileName.replace(/\\/g, "/"),
                size,
                maxBytes,
              ),
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      readStream.on("error", fail);
      readStream.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks));
      });
    });
  });
}

type ZipJsonEntryHandler = (file: {
  name: string;
  content: string;
  byteSize: number;
  scanned: number;
  jsonFiles: number;
}) => void | Promise<void>;

/**
 * Stream JSON entries from a zip (path or buffer) with fail-closed size caps.
 * Invokes `onEntry` once per JSON file; does not retain entry contents itself.
 */
async function forEachZipJsonEntry(
  source: ZipImportSource,
  options: ImportRunOptions | undefined,
  onEntry: ZipJsonEntryHandler,
): Promise<{ filesScanned: number; jsonFiles: number }> {
  const limits = resolveZipSafetyLimits(options?.zipSafetyLimits);
  const zipfile = await openZipSource(source);
  let filesScanned = 0;
  let jsonFiles = 0;
  let extractedJsonBytes = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      zipfile.on("error", fail);
      zipfile.on("end", done);

      zipfile.on("entry", (entry: Entry) => {
        void (async () => {
          try {
            throwIfCancelled(options?.shouldCancel);
            filesScanned += 1;
            const name = entry.fileName.replace(/\\/g, "/");

            if (/\/$/.test(entry.fileName) || !isJsonZipEntryName(name)) {
              zipfile.readEntry();
              return;
            }

            const headerUncompressed =
              typeof entry.uncompressedSize === "number"
                ? entry.uncompressedSize
                : null;
            if (
              headerUncompressed != null &&
              headerUncompressed > limits.maxEntryUncompressedBytes
            ) {
              throw new ImportZipSafetyError(
                importZipEntryTooLargeMessage(
                  name,
                  headerUncompressed,
                  limits.maxEntryUncompressedBytes,
                ),
              );
            }
            if (
              headerUncompressed != null &&
              extractedJsonBytes + headerUncompressed >
                limits.maxTotalExtractedJsonBytes
            ) {
              throw new ImportZipSafetyError(
                importZipExtractBudgetExceededMessage(
                  name,
                  extractedJsonBytes + headerUncompressed,
                  limits.maxTotalExtractedJsonBytes,
                ),
              );
            }

            let data: Buffer;
            try {
              data = await readZipEntryBuffer(
                zipfile,
                entry,
                limits.maxEntryUncompressedBytes,
              );
            } catch (error) {
              if (error instanceof ImportZipSafetyError) throw error;
              // Skip corrupt / unreadable entries (non-safety failures).
              zipfile.readEntry();
              return;
            }

            const byteSize = data.byteLength;
            if (byteSize > limits.maxEntryUncompressedBytes) {
              throw new ImportZipSafetyError(
                importZipEntryTooLargeMessage(
                  name,
                  byteSize,
                  limits.maxEntryUncompressedBytes,
                ),
              );
            }
            if (
              extractedJsonBytes + byteSize > limits.maxTotalExtractedJsonBytes
            ) {
              throw new ImportZipSafetyError(
                importZipExtractBudgetExceededMessage(
                  name,
                  extractedJsonBytes + byteSize,
                  limits.maxTotalExtractedJsonBytes,
                ),
              );
            }

            extractedJsonBytes += byteSize;
            jsonFiles += 1;
            const content = data.toString("utf8");
            await onEntry({
              name,
              content,
              byteSize,
              scanned: filesScanned,
              jsonFiles,
            });
            zipfile.readEntry();
          } catch (error) {
            fail(error);
            try {
              zipfile.close();
            } catch {
              // ignore
            }
          }
        })();
      });

      zipfile.readEntry();
    });
  } finally {
    try {
      zipfile.close();
    } catch {
      // ignore
    }
  }

  return { filesScanned, jsonFiles };
}

/**
 * Extract JSON text files from an Instagram export zip (buffer or path).
 *
 * Safety: per-entry uncompressed size and total extracted-JSON budget are
 * enforced before/after streaming entry bytes. Fail closed with ImportZipSafetyError.
 *
 * Prefer `processZipExportStreaming` for production imports (parse-and-drop).
 * This helper retains all JSON strings and is mainly for tests / callers that
 * need the raw file list.
 */
export async function extractJsonFilesFromZip(
  source: ZipImportSource,
  options?: ImportRunOptions,
): Promise<Array<{ name: string; content: string; byteSize: number }>> {
  const files: Array<{ name: string; content: string; byteSize: number }> = [];

  const { filesScanned, jsonFiles } = await forEachZipJsonEntry(
    source,
    options,
    async (file) => {
      files.push({
        name: file.name,
        content: file.content,
        byteSize: file.byteSize,
      });
      if (file.scanned % 25 === 0) {
        await emitProgress(options?.onProgress, {
          phase: "extracting",
          processed: file.scanned,
          total: Math.max(1, file.scanned),
          message: `Scanning zip… ${file.jsonFiles} JSON file${file.jsonFiles === 1 ? "" : "s"} found`,
          details: { filesScanned: file.scanned, jsonFiles: file.jsonFiles },
        });
      }
    },
  );

  await emitProgress(options?.onProgress, {
    phase: "extracting",
    processed: Math.max(1, filesScanned),
    total: Math.max(1, filesScanned),
    message: `Found ${jsonFiles} JSON file${jsonFiles === 1 ? "" : "s"}`,
    details: { filesScanned, jsonFiles },
  });

  return files;
}

type StreamedZipExport = {
  schemaCatalog: FileSchemaCatalogEntry[];
  parsed: ParseResult;
  likedParsed: LikesParseResult;
  fileNames: string[];
};

/**
 * Stream zip JSON entries: infer schema + accumulate saves/likes parse state,
 * then drop each file's content before the next entry (Gate B+ D2).
 */
async function processZipExportStreaming(
  source: ZipImportSource,
  options?: ImportRunOptions,
): Promise<StreamedZipExport> {
  const schemaCatalog: FileSchemaCatalogEntry[] = [];
  const savesAcc = createSavesParseAccumulator();
  const likesAcc = createLikesParseAccumulator();
  const fileNames: string[] = [];

  await emitProgress(options?.onProgress, {
    phase: "extracting",
    processed: 0,
    total: 1,
    message: "Opening zip archive…",
    details: { filesScanned: 0, jsonFiles: 0 },
  });

  const { filesScanned, jsonFiles } = await forEachZipJsonEntry(
    source,
    options,
    async (file) => {
      fileNames.push(file.name);

      await emitProgress(options?.onProgress, {
        phase: "extracting",
        processed: file.scanned,
        total: Math.max(1, file.scanned),
        message: `Scanning zip… ${file.jsonFiles} JSON file${file.jsonFiles === 1 ? "" : "s"} found`,
        details: { filesScanned: file.scanned, jsonFiles: file.jsonFiles },
      });

      await emitProgress(options?.onProgress, {
        phase: "inferring_schemas",
        processed: file.jsonFiles,
        total: Math.max(1, file.jsonFiles),
        message: `Inferring schemas… ${file.jsonFiles}`,
        details: {
          schemasInferred: file.jsonFiles,
          jsonFiles: file.jsonFiles,
        },
      });
      schemaCatalog.push(
        inferFileSchema(file.name, file.content, {
          byteSize: file.byteSize,
          truncatedRead: false,
        }),
      );

      await emitProgress(options?.onProgress, {
        phase: "parsing_saves",
        processed: file.jsonFiles,
        total: Math.max(1, file.jsonFiles),
        message: `Parsing saves… ${file.jsonFiles} file${file.jsonFiles === 1 ? "" : "s"}`,
        details: { jsonFiles: file.jsonFiles },
      });
      accumulateExportJsonFile(savesAcc, file);

      await emitProgress(options?.onProgress, {
        phase: "parsing_likes",
        processed: file.jsonFiles,
        total: Math.max(1, file.jsonFiles),
        message: "Parsing likes…",
        details: { jsonFiles: file.jsonFiles },
      });
      accumulateLikedExportJsonFile(likesAcc, file);

      if (file.jsonFiles % 5 === 0) await yieldToEventLoop();
    },
  );

  const parsed = finalizeSavesParse(savesAcc);
  const likedParsed = finalizeLikesParse(likesAcc);

  await emitProgress(options?.onProgress, {
    phase: "extracting",
    processed: Math.max(1, filesScanned),
    total: Math.max(1, filesScanned),
    message: `Found ${jsonFiles} JSON file${jsonFiles === 1 ? "" : "s"}`,
    details: { filesScanned, jsonFiles },
  });
  await emitProgress(options?.onProgress, {
    phase: "parsing_saves",
    processed: Math.max(1, jsonFiles),
    total: Math.max(1, jsonFiles),
    message: `Parsed ${parsed.items.length} saved item${parsed.items.length === 1 ? "" : "s"}`,
    details: { jsonFiles, itemsParsed: parsed.items.length },
  });
  await emitProgress(options?.onProgress, {
    phase: "parsing_likes",
    processed: Math.max(1, jsonFiles),
    total: Math.max(1, jsonFiles),
    message: `Parsed ${likedParsed.items.length} liked item${likedParsed.items.length === 1 ? "" : "s"}`,
    details: { jsonFiles, likesParsed: likedParsed.items.length },
  });

  return { schemaCatalog, parsed, likedParsed, fileNames };
}

async function emitProgress(
  onProgress: ImportRunOptions["onProgress"],
  progress: ImportProgress,
) {
  await onProgress?.(progress);
}

function throwIfCancelled(shouldCancel?: () => boolean) {
  if (shouldCancel?.()) throw new ImportCancelledError();
}

async function yieldToEventLoop() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function appendImportNotes(importId: number, extra: string) {
  const row = getDb()
    .select({ notes: imports.notes })
    .from(imports)
    .where(eq(imports.id, importId))
    .get();
  const next = row?.notes ? `${row.notes}\n${extra}` : extra;
  getDb()
    .update(imports)
    .set({ notes: next })
    .where(eq(imports.id, importId))
    .run();
}

async function syncEmbeddingsAfterImport(
  importId: number,
  changedIds: number[],
  options?: ImportRunOptions,
  kind: "saves" | "likes" = "saves",
): Promise<string> {
  const total = changedIds.length;
  const label = kind === "saves" ? "item" : "like";
  await emitProgress(options?.onProgress, {
    phase: "indexing",
    processed: 0,
    total: Math.max(1, total),
    message:
      total === 0
        ? `No changed ${label}s need semantic indexing`
        : `Indexing ${total} changed ${label}${total === 1 ? "" : "s"}…`,
    details: { importId },
  });
  throwIfCancelled(options?.shouldCancel);

  try {
    const result =
      kind === "saves"
        ? await syncItemEmbeddings(changedIds)
        : await syncLikedItemEmbeddings(changedIds);
    await emitProgress(options?.onProgress, {
      phase: "indexing",
      processed: Math.max(1, total),
      total: Math.max(1, total),
      message: result.message,
      details: { importId },
    });
    return result.message;
  } catch (error) {
    const message = `Semantic indexing failed; imported data and keyword search are available. ${
      error instanceof Error ? error.message : "Unknown embedding error"
    }`;
    appendImportNotes(importId, message);
    return message;
  }
}

function resolveZipSafetyLimits(
  overrides?: Partial<ImportZipSafetyLimits>,
): ImportZipSafetyLimits {
  return {
    maxEntryUncompressedBytes:
      overrides?.maxEntryUncompressedBytes ??
      DEFAULT_IMPORT_ZIP_SAFETY_LIMITS.maxEntryUncompressedBytes,
    maxTotalExtractedJsonBytes:
      overrides?.maxTotalExtractedJsonBytes ??
      DEFAULT_IMPORT_ZIP_SAFETY_LIMITS.maxTotalExtractedJsonBytes,
  };
}

async function catalogSchemasWithProgress(
  files: Array<{ name: string; content: string; byteSize?: number }>,
  options?: ImportRunOptions,
): Promise<FileSchemaCatalogEntry[]> {
  const catalog: FileSchemaCatalogEntry[] = [];
  const total = files.length;

  if (total === 0) {
    await emitProgress(options?.onProgress, {
      phase: "inferring_schemas",
      processed: 0,
      total: 1,
      message: "No JSON files to infer schemas from",
      details: { schemasInferred: 0, jsonFiles: 0 },
    });
    return catalog;
  }

  for (let i = 0; i < files.length; i++) {
    throwIfCancelled(options?.shouldCancel);
    const file = files[i]!;
    const size = file.byteSize ?? Buffer.byteLength(file.content, "utf8");
    catalog.push(
      inferFileSchema(file.name, file.content, {
        byteSize: size,
        truncatedRead: false,
      }),
    );
    await emitProgress(options?.onProgress, {
      phase: "inferring_schemas",
      processed: i + 1,
      total,
      message: `Inferring schemas… ${i + 1}/${total}`,
      details: {
        schemasInferred: i + 1,
        jsonFiles: total,
      },
    });
    if ((i + 1) % 5 === 0) await yieldToEventLoop();
  }

  return catalog;
}

async function parseExportJsonFilesWithProgress(
  files: Array<{ name: string; content: string }>,
  options?: ImportRunOptions,
) {
  // parseExportJsonFiles is synchronous; report before/after and yield.
  await emitProgress(options?.onProgress, {
    phase: "parsing_saves",
    processed: 0,
    total: Math.max(1, files.length),
    message: `Parsing ${files.length} JSON file${files.length === 1 ? "" : "s"}…`,
    details: { jsonFiles: files.length },
  });
  throwIfCancelled(options?.shouldCancel);

  const parsed = parseExportJsonFiles(files);

  await emitProgress(options?.onProgress, {
    phase: "parsing_saves",
    processed: Math.max(1, files.length),
    total: Math.max(1, files.length),
    message: `Parsed ${parsed.items.length} saved item${parsed.items.length === 1 ? "" : "s"}`,
    details: {
      jsonFiles: files.length,
      itemsParsed: parsed.items.length,
    },
  });

  return parsed;
}

async function parseLikedExportJsonFilesWithProgress(
  files: Array<{ name: string; content: string }>,
  options?: ImportRunOptions,
) {
  await emitProgress(options?.onProgress, {
    phase: "parsing_likes",
    processed: 0,
    total: Math.max(1, files.length),
    message: "Parsing likes…",
    details: { jsonFiles: files.length },
  });
  throwIfCancelled(options?.shouldCancel);

  const parsed = parseLikedExportJsonFiles(files);

  await emitProgress(options?.onProgress, {
    phase: "parsing_likes",
    processed: Math.max(1, files.length),
    total: Math.max(1, files.length),
    message: `Parsed ${parsed.items.length} liked item${parsed.items.length === 1 ? "" : "s"}`,
    details: {
      jsonFiles: files.length,
      likesParsed: parsed.items.length,
    },
  });

  return parsed;
}

function persistImportSchemas(
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

async function applyParsedItems(
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

async function applyLikedItems(
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
    if (error instanceof ImportCancelledError) {
      db.update(imports)
        .set({ status: "failed", error: "Import cancelled" })
        .where(eq(imports.id, draftId))
        .run();
      throw error;
    }

    const message =
      error instanceof Error ? error.message : "Import failed unexpectedly";
    db.update(imports)
      .set({ status: "failed", error: message })
      .where(eq(imports.id, draftId))
      .run();

    await emitProgress(options?.onProgress, {
      phase: "failed",
      processed: 0,
      total: Math.max(1, items.length + liked.length),
      message,
      details: {
        importId: draftId,
        itemsParsed: items.length,
        likesParsed: liked.length,
      },
    });

    return {
      importId: draftId,
      status: "failed",
      filename,
      contentHash,
      itemsFound: items.length,
      itemsAdded: 0,
      itemsUpdated: 0,
      itemsSkipped: 0,
      likesFound: liked.length,
      likesAdded: 0,
      likesUpdated: 0,
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
