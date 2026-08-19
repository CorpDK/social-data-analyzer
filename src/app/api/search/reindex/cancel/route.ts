import { NextResponse } from "next/server";
import { jsonInternalError } from "@/lib/api-error";
import { rejectUnlessLocalMutating } from "@/lib/local-request-guard";
import { readJsonBody, readOptionalJobId } from "@/lib/request-json";
import { cancelReindexJob } from "@/lib/search/jobs";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cooperative cancel for the active (or specified) running job; pending stay queued. */
export async function POST(request: Request) {
  const rejected = rejectUnlessLocalMutating(request);
  if (rejected) return rejected;

  try {
    await getStorage();
    // Empty / invalid body cancels the active job.
    const parsed = await readJsonBody(request);
    const jobId = parsed.ok ? readOptionalJobId(parsed.value) : undefined;

    const result = await cancelReindexJob(jobId);
    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.error,
          code: "REINDEX_CANCEL_REJECTED",
          job: result.job ?? null,
        },
        { status: result.status },
      );
    }

    return NextResponse.json({ job: result.job });
  } catch (error) {
    return jsonInternalError("Failed to cancel reindex", error, {
      code: "REINDEX_CANCEL_FAILED",
      message: "Failed to cancel reindex",
    });
  }
}
