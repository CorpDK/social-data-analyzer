/** Upper bound for Instagram export uploads (full Meta zips with media). */
export const IMPORT_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/** Human-readable label for UI / API error messages. */
export const IMPORT_MAX_FILE_LABEL = "2GB";

/**
 * Next.js `SizeLimit` string for `experimental.proxyClientMaxBodySize` /
 * `experimental.serverActions.bodySizeLimit` (see next.config.ts).
 */
export const IMPORT_MAX_FILE_SIZE_LIMIT = "2gb";

export function importFileTooLargeMessage(): string {
  return `File is too large (max ${IMPORT_MAX_FILE_LABEL}).`;
}
