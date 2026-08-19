import type Database from "better-sqlite3";
import type { JobStore } from "../ports";
import {
  getActiveEmbeddingJob,
  getDisplayEmbeddingJob,
  getEmbeddingJob,
  getLatestEmbeddingJob,
  getLatestFinishedEmbeddingJob,
  getOpenJobForTarget,
  getPendingEmbeddingJobs,
  getRecentEmbeddingJobs,
  hasOpenEmbeddingJobForTarget,
  listEmbeddingJobs,
} from "../../search/jobs-records";
import {
  getActiveImportJob,
  getDisplayImportJob,
  getImportJob,
  getImportJobsStatus,
  getLatestFinishedImportJob,
  getPendingImportJobs,
  getRecentImportJobs,
} from "../../import/jobs";
import {
  reclaimOrphanedEmbeddingJobRows,
  reclaimOrphanedImportJobRows,
} from "../../job-queue";

export function createSqliteJobStore(sqlite: Database.Database): JobStore {
  return {
    getEmbeddingJob: async (id) => getEmbeddingJob(id),
    getLatestEmbeddingJob: async () => getLatestEmbeddingJob(),
    getLatestFinishedEmbeddingJob: async () => getLatestFinishedEmbeddingJob(),
    getActiveEmbeddingJob: async () => getActiveEmbeddingJob(),
    getPendingEmbeddingJobs: async () => getPendingEmbeddingJobs(),
    getRecentEmbeddingJobs: async (limit) => getRecentEmbeddingJobs(limit),
    listEmbeddingJobs: async (options) => listEmbeddingJobs(options),
    getDisplayEmbeddingJob: async () => getDisplayEmbeddingJob(),
    getOpenJobForTarget: async (target) => getOpenJobForTarget(target),
    hasOpenEmbeddingJobForTarget: async (target) =>
      hasOpenEmbeddingJobForTarget(target),

    getImportJob: async (id) => getImportJob(id),
    getActiveImportJob: async () => getActiveImportJob(),
    getPendingImportJobs: async () => getPendingImportJobs(),
    getLatestFinishedImportJob: async () => getLatestFinishedImportJob(),
    getDisplayImportJob: async () => getDisplayImportJob(),
    getRecentImportJobs: async (limit) => getRecentImportJobs(limit),
    getImportJobsStatus: async () => getImportJobsStatus(),

    reclaimOrphanedEmbeddingJobs: async () =>
      reclaimOrphanedEmbeddingJobRows(sqlite),
    reclaimOrphanedImportJobs: async () =>
      reclaimOrphanedImportJobRows(sqlite),
  };
}
