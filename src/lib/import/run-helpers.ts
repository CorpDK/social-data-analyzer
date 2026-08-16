import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import {
  inferFileSchema,
  type FileSchemaCatalogEntry,
} from "../json-schema-infer";
import {
  parseExportJsonFiles,
  parseLikedExportJsonFiles,
} from "../parse-export";
import {
  syncItemEmbeddings,
  syncLikedItemEmbeddings,
} from "../search/sync";
import { emitProgress, throwIfCancelled, yieldToEventLoop } from "./progress";
import type { ImportRunOptions } from "./types";

const { imports } = schema;

export function appendImportNotes(importId: number, extra: string) {
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

export async function syncEmbeddingsAfterImport(
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

export async function catalogSchemasWithProgress(
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

export async function parseExportJsonFilesWithProgress(
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

export async function parseLikedExportJsonFilesWithProgress(
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
