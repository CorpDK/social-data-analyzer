import { createHash } from "node:crypto";
import fs from "node:fs";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import {
  DEFAULT_IMPORT_ZIP_SAFETY_LIMITS,
  importZipEntryTooLargeMessage,
  importZipExtractBudgetExceededMessage,
  type ImportZipSafetyLimits,
} from "../import-limits";
import { emitProgress, throwIfCancelled } from "./progress";
import {
  ImportZipSafetyError,
  type ImportRunOptions,
  type ZipImportSource,
} from "./types";

export type { ZipImportSource } from "./types";

export function hashBuffer(buffer: Buffer): string {
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

export async function hashZipSource(source: ZipImportSource): Promise<string> {
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
export async function forEachZipJsonEntry(
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

export function resolveZipSafetyLimits(
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
