import { NextResponse } from "next/server";
import { cancelReindexJob } from "@/lib/search/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cooperative cancel for the active (or specified) reindex job. */
export async function POST(request: Request) {
  try {
    let jobId: number | undefined;
    try {
      const body = (await request.json()) as { jobId?: unknown };
      if (typeof body.jobId === "number" && Number.isFinite(body.jobId)) {
        jobId = Math.trunc(body.jobId);
      }
    } catch {
      // Empty body cancels the active job.
    }

    const result = cancelReindexJob(jobId);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, job: result.job ?? null },
        { status: result.status },
      );
    }

    return NextResponse.json({ job: result.job });
  } catch (error) {
    console.error("Failed to cancel reindex", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to cancel reindex",
      },
      { status: 500 },
    );
  }
}
