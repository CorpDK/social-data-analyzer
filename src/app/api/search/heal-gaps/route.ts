import { NextResponse } from "next/server";
import { jsonInternalError } from "@/lib/api-error";
import { rejectUnlessLocalMutating } from "@/lib/local-request-guard";
import { scheduleSearchBackfillJobsIfNeeded } from "@/lib/search/readiness";
import { getStorage } from "@/lib/storage";

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
    await getStorage();
    const result = await scheduleSearchBackfillJobsIfNeeded();
    return NextResponse.json(
      {
        gaps: result.gaps,
        enqueued: result.enqueued,
        skipped: result.skipped,
      },
      { status: result.enqueued.length > 0 ? 202 : 200 },
    );
  } catch (error) {
    return jsonInternalError("Failed to heal search gaps", error, {
      code: "HEAL_GAPS_FAILED",
      message: "Failed to heal search gaps",
    });
  }
}
