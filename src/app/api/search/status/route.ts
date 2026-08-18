import { NextResponse } from "next/server";
import { jsonInternalError } from "@/lib/api-error";
import { getSearchIndexStatus } from "@/lib/search/status";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(getSearchIndexStatus());
  } catch (error) {
    return jsonInternalError("Failed to load search index status", error, {
      code: "SEARCH_STATUS_FAILED",
      message: "Failed to load search index status",
    });
  }
}
