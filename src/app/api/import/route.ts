import { NextResponse } from "next/server";
import { startImportJob } from "@/lib/import/jobs";
import {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_JSON_FILE_BYTES,
  importFileTooLargeMessage,
} from "@/lib/import-limits";
import { rejectUnlessLocalMutating } from "@/lib/local-request-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Multipart overhead allowance on Content-Length vs bare file size. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * Accept an export upload, spool it to disk, enqueue a background import job,
 * and return immediately (202). Progress via GET /api/import/jobs or SSE
 * GET /api/import/jobs/stream.
 *
 * Note: `request.formData()` buffers the multipart body before spooling.
 * Caps in import-limits match that in-memory reality; File.stream() still
 * writes the spool without a second full Buffer copy.
 */
export async function POST(request: Request) {
  const rejected = rejectUnlessLocalMutating(request);
  if (rejected) return rejected;

  try {
    const contentLengthHeader = request.headers.get("content-length");
    if (contentLengthHeader) {
      const contentLength = Number(contentLengthHeader);
      // Zip and JSON share the same 512MB bound today; reject early if CL exceeds
      // the larger of the two (+ multipart overhead) without buffering formData.
      const maxAccepted =
        Math.max(IMPORT_MAX_FILE_BYTES, IMPORT_MAX_JSON_FILE_BYTES) +
        MULTIPART_OVERHEAD_BYTES;
      if (Number.isFinite(contentLength) && contentLength > maxAccepted) {
        return NextResponse.json(
          { error: importFileTooLargeMessage("zip") },
          { status: 413 },
        );
      }
    }

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
