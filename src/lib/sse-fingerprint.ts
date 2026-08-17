/**
 * Cheap SSE change fingerprints — avoid JSON.stringify of full status snapshots.
 * Only job/progress-relevant fields; coverage counts change on full refresh.
 */

import type { ImportJobsStatusDto } from "./import/jobs-dto";
import type {
  EmbeddingJobDto,
  LibraryIndexStatusDto,
  ProviderIndexStatusDto,
  SearchIndexStatusDto,
} from "./search/status-dto";

function jobFp(job: EmbeddingJobDto | ImportJobsStatusDto["job"] | null | undefined): string {
  if (!job) return "-";
  return [
    job.id,
    job.state,
    job.phase,
    job.processed,
    job.total,
    job.updatedAt,
    "error" in job ? (job.error ?? "") : "",
    job.message ?? "",
    "cancelRequested" in job ? Number(job.cancelRequested) : "",
  ].join(":");
}

function jobsListFp(
  jobs: Array<EmbeddingJobDto | NonNullable<ImportJobsStatusDto["job"]>> | undefined,
): string {
  if (!jobs?.length) return "";
  return jobs.map((j) => jobFp(j)).join(",");
}

function providerFp(p: ProviderIndexStatusDto): string {
  return [
    p.provider,
    p.library,
    p.enabled ? 1 : 0,
    p.configured ? 1 : 0,
    p.health,
    p.embeddedCount,
    p.totalItems,
    p.coveragePercent,
    p.indexPresent ? 1 : 0,
    p.reindexRefused ? 1 : 0,
  ].join(":");
}

function libraryFp(lib: LibraryIndexStatusDto | undefined): string {
  if (!lib) return "-";
  return [
    lib.totalItems,
    lib.ftsCount,
    lib.providers.map(providerFp).join("|"),
  ].join(";");
}

/** Fingerprint for `/api/search/status/stream` snapshots. */
export function searchStatusFingerprint(snapshot: SearchIndexStatusDto): string {
  const libs = snapshot.libraries;
  return [
    jobFp(snapshot.job),
    jobsListFp(snapshot.pendingJobs),
    jobsListFp(snapshot.recentJobs),
    snapshot.totalItems,
    snapshot.ftsCount,
    libraryFp(libs?.saves),
    libraryFp(libs?.likes),
    snapshot.host?.memAvailableMb ?? "",
    snapshot.cancelSupported ? 1 : 0,
  ].join("#");
}

/** Fingerprint for `/api/import/jobs/stream` snapshots. */
export function importJobsFingerprint(snapshot: ImportJobsStatusDto): string {
  return [
    jobFp(snapshot.job),
    jobsListFp(snapshot.pendingJobs),
    jobsListFp(snapshot.recentJobs),
    snapshot.cancelSupported ? 1 : 0,
  ].join("#");
}
