import { NextResponse } from "next/server";
import { startImportJobFromSpool } from "@/lib/import/jobs";
import {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_JSON_FILE_BYTES,
  importFileTooLargeMessage,
} from "@/lib/import-limits";
import {
  MultipartUploadError,
  spoolMultipartFileUpload,
} from "@/lib/import/multipart-stream";
import { rejectUnlessLocalMutating } from "@/lib/local-request-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Multipart overhead allowance on Content-Length vs bare file size. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * Accept an export upload, stream multipart to disk, enqueue a background
 * import job, and return immediately (202). Progress via GET /api/import/jobs
 * or SSE GET /api/import/jobs/stream.
 *
 * Multipart is parsed incrementally (no `request.formData()` full-body buffer);
 * the file part is written straight to the spool with a size counter.
 */
export async function POST(request: Request) {
  const rejected = rejectUnlessLocalMutating(request);
  if (rejected) return rejected;

  try {
    const contentLengthHeader = request.headers.get("content-length");
    if (contentLengthHeader) {
      const contentLength = Number(contentLengthHeader);
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

    const uploaded = await spoolMultipartFileUpload(request, {
      provisionalMaxBytes: Math.max(
        IMPORT_MAX_FILE_BYTES,
        IMPORT_MAX_JSON_FILE_BYTES,
      ),
    });

    const result = startImportJobFromSpool({
      filename: uploaded.filename,
      kind: uploaded.kind,
      spoolPath: uploaded.spool.spoolPath,
      contentHash: uploaded.spool.contentHash,
      byteLength: uploaded.spool.byteLength,
    });
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
    if (error instanceof MultipartUploadError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    const message =
      error instanceof Error ? error.message : "Unexpected import error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
