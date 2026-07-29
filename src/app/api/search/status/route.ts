import { NextResponse } from "next/server";
import { getSearchIndexStatus } from "@/lib/search/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(getSearchIndexStatus());
  } catch (error) {
    console.error("Failed to load search index status", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load search index status",
      },
      { status: 500 },
    );
  }
}
