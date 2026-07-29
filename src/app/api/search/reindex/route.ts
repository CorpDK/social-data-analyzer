import { NextResponse } from "next/server";
import {
  getActiveEmbeddingJob,
  getLatestEmbeddingJob,
  parseReindexTarget,
  startReindexJob,
} from "@/lib/search/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Current / latest reindex job progress (also included in GET /api/search/status). */
export async function GET() {
  try {
    const active = getActiveEmbeddingJob();
    return NextResponse.json({
      job: active ?? getLatestEmbeddingJob(),
      cancelSupported: true,
    });
  } catch (error) {
    console.error("Failed to load reindex status", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load reindex status",
      },
      { status: 500 },
    );
  }
}

/**
 * Start a background reindex on the Node process.
 * Returns immediately with the job record; poll GET for progress.
 */
export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const provider =
      body && typeof body === "object" && "provider" in body
        ? (body as { provider: unknown }).provider
        : undefined;

    const target = parseReindexTarget(provider);
    if (!target) {
      return NextResponse.json(
        {
          error:
            "provider must be one of: local, ollama, openai, voyage, all-configured",
        },
        { status: 400 },
      );
    }

    const result = startReindexJob(target);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, job: result.job ?? null },
        { status: result.status },
      );
    }

    return NextResponse.json({ job: result.job }, { status: 202 });
  } catch (error) {
    console.error("Failed to start reindex", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to start reindex",
      },
      { status: 500 },
    );
  }
}
