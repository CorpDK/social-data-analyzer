import { NextResponse } from "next/server";
import { startImportJob } from "@/lib/import/jobs";
import { rejectUnlessLocalMutating } from "@/lib/local-request-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Accept an export upload, spool it to disk, enqueue a background import job,
 * and return immediately (202). Progress via GET /api/import/jobs or SSE
 * GET /api/import/jobs/stream.
 */
export async function POST(request: Request) {
  const rejected = rejectUnlessLocalMutating(request);
  if (rejected) return rejected;

  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Upload a .zip or .json Instagram export file." },
        { status: 400 },
      );
    }

    const result = await startImportJob(file);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      );
    }

    return NextResponse.json(
      { jobId: result.job.id, job: result.job },
      { status: 202 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected import error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
