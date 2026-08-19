import { NextResponse } from "next/server";
import { jsonInternalError } from "@/lib/api-error";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Active + pending import jobs only (terminal jobs live in history / recentJobs). */
export async function GET() {
  try {
    const storage = await getStorage();
    return NextResponse.json(await storage.jobs.getImportJobsStatus());
  } catch (error) {
    return jsonInternalError("Failed to load import job status", error, {
      code: "IMPORT_JOBS_STATUS_FAILED",
      message: "Failed to load import job status",
    });
  }
}
