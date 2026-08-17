import {
  getImportJobsStatus,
  isImportQueueIdle,
} from "@/lib/import/jobs";
import { IMPORT_JOBS_CHANNEL, createJobSseResponse } from "@/lib/sse";
import { importJobsFingerprint } from "@/lib/sse-fingerprint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-Sent Events for import job progress.
 * Emits `snapshot` on connect and on change; emits `idle` when the queue drains
 * (stream stays open — client closes EventSource so it does not auto-reconnect).
 */
export async function GET(request: Request) {
  return createJobSseResponse({
    channel: IMPORT_JOBS_CHANNEL,
    getSnapshot: () => getImportJobsStatus(),
    fingerprint: importJobsFingerprint,
    isIdle: isImportQueueIdle,
    signal: request.signal,
  });
}
