import { NextResponse } from "next/server";
import { jsonInternalError } from "@/lib/api-error";
import { getImportJobsStatus } from "@/lib/import/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Active + pending import jobs only (terminal jobs live in history / recentJobs). */
export async function GET() {
  try {
    return NextResponse.json(getImportJobsStatus());
  } catch (error) {
    return jsonInternalError("Failed to load import job status", error, {
      code: "IMPORT_JOBS_STATUS_FAILED",
      message: "Failed to load import job status",
    });
  }
}
