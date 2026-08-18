import { NextResponse } from "next/server";
import { rejectUnlessLocalMutating } from "@/lib/local-request-guard";
import { scheduleSearchBackfillJobsIfNeeded } from "@/lib/search/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Explicitly enqueue FTS / local backfill when coverage lags.
 * Status GET is read-only; call this from Indexes UI ("Heal gaps") or startup.
 */
export async function POST(request: Request) {
  const rejected = rejectUnlessLocalMutating(request);
  if (rejected) return rejected;

  try {
    const result = scheduleSearchBackfillJobsIfNeeded();
    return NextResponse.json(
      {
        gaps: result.gaps,
        enqueued: result.enqueued,
        skipped: result.skipped,
      },
      { status: result.enqueued.length > 0 ? 202 : 200 },
    );
  } catch (error) {
    console.error("Failed to heal search gaps", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to heal search gaps",
      },
      { status: 500 },
    );
  }
}
