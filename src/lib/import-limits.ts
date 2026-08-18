/**
 * Upload / zip-extract safety caps.
 *
 * `POST /api/import` streams multipart via a boundary parser into the spool
 * (no `request.formData()` full-body buffer). Zip uploads are still capped at
 * 512 MiB for honest host RAM / proxy alignment; standalone JSON stays at
 * 512 MiB because parse loads a UTF-8 string (Node/V8 string limits).
 */

/**
 * Max size for `.zip` uploads via streaming multipart → spool.
 * Also used as the Next experimental bodySizeLimit string source.
 */
export const IMPORT_MAX_FILE_BYTES = 512 * 1024 * 1024; // 512 MiB

/** Human-readable label for zip / general upload UI + errors. */
export const IMPORT_MAX_FILE_LABEL = "512MB";

/**
 * Next.js `SizeLimit` string for `experimental.proxyClientMaxBodySize` /
 * `experimental.serverActions.bodySizeLimit` (see next.config.ts).
 */
export const IMPORT_MAX_FILE_SIZE_LIMIT = "512mb";

/**
 * Standalone `.json` import cap. JSON is read into a UTF-8 string for parse;
 * Node / V8 string size limits make multi‑GiB JSON unsafe even if disk spool
 * succeeded. Kept at 512 MiB with a dedicated error message.
 */
export const IMPORT_MAX_JSON_FILE_BYTES = 512 * 1024 * 1024; // 512 MiB

/** Human-readable label for standalone JSON upload errors. */
export const IMPORT_MAX_JSON_FILE_LABEL = "512MB";

/**
 * Per-entry uncompressed size cap for JSON files inside an export zip.
 * Checked from the zip header before `getData()` and again on the buffer.
 * Large Meta likes/saves JSON can be tens–hundreds of MB; 512 MiB leaves
 * headroom while failing closed on zip bombs / multi-GiB entries.
 */
export const IMPORT_MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

/** Human-readable label for per-entry cap errors. */
export const IMPORT_MAX_ZIP_ENTRY_LABEL = "512MB";

/**
 * Total budget for JSON bytes streamed out of a zip during import (running
 * sum of per-entry sizes). Media in the zip is never extracted.
 *
 * Peak RAM (Gate B+ D2): production zip import streams from the spool path via
 * yauzl and parse-and-drops each JSON file (schema + parse accumulators only).
 * It does not hold the full spool buffer + all JSON strings at once. Caps still
 * fail closed on bombs / oversized entries.
 */
export const IMPORT_MAX_EXTRACTED_JSON_BYTES = 768 * 1024 * 1024;

/**
 * Items per SQLite write transaction during import persist.
 * Avoids one transaction per row on large Meta exports while keeping progress
 * ticks responsive (Gate B+ N2).
 */
export const IMPORT_WRITE_BATCH_SIZE = 500;

/** Human-readable label for total extracted-JSON budget errors. */
export const IMPORT_MAX_EXTRACTED_JSON_LABEL = "768MB";

export type ImportZipSafetyLimits = {
  maxEntryUncompressedBytes: number;
  maxTotalExtractedJsonBytes: number;
};

export const DEFAULT_IMPORT_ZIP_SAFETY_LIMITS: ImportZipSafetyLimits = {
  maxEntryUncompressedBytes: IMPORT_MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
  maxTotalExtractedJsonBytes: IMPORT_MAX_EXTRACTED_JSON_BYTES,
};

export type ImportUploadKind = "zip" | "json";

/** Byte cap for a given upload kind (zip multipart vs standalone JSON). */
export function importMaxBytesForKind(kind: ImportUploadKind): number {
  return kind === "json"
    ? IMPORT_MAX_JSON_FILE_BYTES
    : IMPORT_MAX_FILE_BYTES;
}

export function importMaxLabelForKind(kind: ImportUploadKind): string {
  return kind === "json"
    ? IMPORT_MAX_JSON_FILE_LABEL
    : IMPORT_MAX_FILE_LABEL;
}

/** Infer kind from a filename; null if neither .zip nor .json. */
export function importKindFromFilename(filename: string): ImportUploadKind | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".json")) return "json";
  return null;
}

export function importFileTooLargeMessage(kind: ImportUploadKind = "zip"): string {
  if (kind === "json") return importJsonFileTooLargeMessage();
  return `File is too large (max ${IMPORT_MAX_FILE_LABEL}). Multipart uploads stream to disk; the cap matches proxy/host limits.`;
}

export function importJsonFileTooLargeMessage(): string {
  return (
    `JSON export is too large (max ${IMPORT_MAX_JSON_FILE_LABEL}). ` +
    `Standalone .json imports are loaded as a string for parsing; larger files hit Node/V8 string limits. ` +
    `Prefer a .zip export (JSON entries are streamed from the spool).`
  );
}

export function importZipEntryTooLargeMessage(
  entryName: string,
  sizeBytes: number,
  limitBytes: number = IMPORT_MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
): string {
  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1);
  const limitLabel =
    limitBytes === IMPORT_MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES
      ? IMPORT_MAX_ZIP_ENTRY_LABEL
      : `${(limitBytes / (1024 * 1024)).toFixed(0)}MB`;
  return `Zip entry "${entryName}" is too large when uncompressed (${sizeMb}MB; max ${limitLabel} per JSON file).`;
}

export function importZipExtractBudgetExceededMessage(
  entryName: string,
  totalBytes: number,
  limitBytes: number = IMPORT_MAX_EXTRACTED_JSON_BYTES,
): string {
  const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
  const limitLabel =
    limitBytes === IMPORT_MAX_EXTRACTED_JSON_BYTES
      ? IMPORT_MAX_EXTRACTED_JSON_LABEL
      : `${(limitBytes / (1024 * 1024)).toFixed(0)}MB`;
  return `Extracted JSON from the zip would exceed the in-memory budget (${totalMb}MB including "${entryName}"; max ${limitLabel} total).`;
}
