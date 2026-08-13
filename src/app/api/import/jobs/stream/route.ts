import {
  getImportJobsStatus,
  isImportQueueIdle,
} from "@/lib/import/jobs";
import { IMPORT_JOBS_CHANNEL, createJobSseResponse } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-Sent Events for import job progress.
 * Emits `snapshot` on connect and on change; `idle` then closes when the queue drains.
 */
export async function GET(request: Request) {
  return createJobSseResponse({
    channel: IMPORT_JOBS_CHANNEL,
    getSnapshot: () => getImportJobsStatus(),
    isIdle: isImportQueueIdle,
    signal: request.signal,
  });
}
