import type { ImportLog } from "../import-log";
import type { ImportZipSafetyLimits } from "../import-limits";

/** Zip bytes in memory, or a spool/file path streamed via yauzl. */
export type ZipImportSource = Buffer | string;

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
