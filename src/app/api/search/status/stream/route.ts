import { getSearchIndexStatusForStream } from "@/lib/search/status";
import { SEARCH_STATUS_CHANNEL, createJobSseResponse } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-Sent Events for search index status + reindex progress.
 * Push-on-change with heartbeats; stays open until the client disconnects.
 * While a job runs, expensive vec COUNTs are refreshed infrequently —
 * progress ticks use job processed/total from the DB.
 *
 * Idle policy (intentional, unlike import): no `idle` event — the Indexes UI
 * keeps watching coverage/health when the queue is empty. Import streams emit
 * `idle` so the upload form can close EventSource. Fingerprint cheapening is
 * Gate A (D5), not A−.
 */
export async function GET(request: Request) {
  return createJobSseResponse({
    channel: SEARCH_STATUS_CHANNEL,
    getSnapshot: () => getSearchIndexStatusForStream(),
    // Pub/sub covers progress; slower poll is a safety net (status snapshot is heavier).
    pollMs: 2_500,
    signal: request.signal,
  });
}
