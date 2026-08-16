import {
  accumulateExportJsonFile,
  accumulateLikedExportJsonFile,
  createLikesParseAccumulator,
  createSavesParseAccumulator,
  finalizeLikesParse,
  finalizeSavesParse,
  type LikesParseResult,
  type ParseResult,
} from "../parse-export";
import {
  inferFileSchema,
  type FileSchemaCatalogEntry,
} from "../json-schema-infer";
import { forEachZipJsonEntry } from "./zip-extract";
import { emitProgress, yieldToEventLoop } from "./progress";
import type { ImportRunOptions, ZipImportSource } from "./types";

export type StreamedZipExport = {
  schemaCatalog: FileSchemaCatalogEntry[];
  parsed: ParseResult;
  likedParsed: LikesParseResult;
  fileNames: string[];
};

/**
 * Stream zip JSON entries: infer schema + accumulate saves/likes parse state,
 * then drop each file's content before the next entry (Gate B+ D2).
 */
export async function processZipExportStreaming(
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

