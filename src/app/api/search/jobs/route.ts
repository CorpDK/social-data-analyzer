import { NextResponse } from "next/server";
import { ensureJobRunner, listEmbeddingJobs } from "@/lib/search/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseNonNegInt(value: string | null, fallback: number): number {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

export async function GET(request: Request) {
  try {
    ensureJobRunner();
    const { searchParams } = new URL(request.url);
    const limit = parseNonNegInt(searchParams.get("limit"), 50);
    const offset = parseNonNegInt(searchParams.get("offset"), 0);
    const result = listEmbeddingJobs({ limit, offset });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to list embedding jobs", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to list embedding jobs",
      },
      { status: 500 },
    );
  }
}
