import { NextResponse } from "next/server";
import {
  ensureImportJobRunner,
  getActiveImportJob,
  getPendingImportJobs,
  getRecentImportJobs,
} from "@/lib/import/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Active + pending import jobs only (terminal jobs live in history / recentJobs). */
export async function GET() {
  try {
    ensureImportJobRunner();
    return NextResponse.json({
      job: getActiveImportJob(),
      pendingJobs: getPendingImportJobs(),
      recentJobs: getRecentImportJobs(5),
      cancelSupported: true,
    });
  } catch (error) {
    console.error("Failed to load import job status", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load import job status",
      },
      { status: 500 },
    );
  }
}
