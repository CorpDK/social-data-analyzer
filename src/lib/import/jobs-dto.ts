/**
 * Client-safe wire types for import jobs.
 * Pure types only — safe to import from `"use client"` modules.
 * Server `import/jobs.ts` implements these shapes.
 */

export type ImportJobState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ImportJobKind = "zip" | "json";

export type ImportJobPhase =
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

export type ImportJobDetailsDto = {
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

export type ImportJobResultDto = {
  importId?: number | null;
  status?: "completed" | "duplicate" | "failed";
  message?: string;
  filename?: string;
  contentHash?: string;
  itemsFound?: number;
  itemsAdded?: number;
  itemsUpdated?: number;
  itemsSkipped?: number;
  likesFound?: number;
  likesAdded?: number;
  likesUpdated?: number;
  likesSkipped?: number;
};

/** Wire shape of an import_jobs row (matches ImportJobRecord on the server). */
export type ImportJobDto = {
  id: number;
  filename: string;
  contentHash?: string | null;
  spoolPath?: string;
  kind?: ImportJobKind;
  state: ImportJobState;
  phase: ImportJobPhase | string;
  processed: number;
  total: number;
  percent: number;
  message: string | null;
  error: string | null;
  details: ImportJobDetailsDto | null;
  result: ImportJobResultDto | null;
  importId: number | null;
  cancelRequested: boolean;
  startedAt: number;
  finishedAt: number | null;
  updatedAt: number;
};

/** `/api/import/jobs` (and SSE snapshot) payload. */
export type ImportJobsStatusDto = {
  job: ImportJobDto | null;
  pendingJobs: ImportJobDto[];
  recentJobs?: ImportJobDto[];
  cancelSupported?: boolean;
};
