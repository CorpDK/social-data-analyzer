import { NextResponse } from "next/server";
import { rejectUnlessLocalMutating } from "@/lib/local-request-guard";
import {
  ensureJobRunner,
  getActiveEmbeddingJob,
  getDisplayEmbeddingJob,
  getPendingEmbeddingJobs,
  parseReindexTarget,
  startReindexJob,
} from "@/lib/search/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Current / latest reindex job progress (also included in GET /api/search/status). */
export async function GET() {
  try {
    ensureJobRunner();
    const active = getActiveEmbeddingJob();
    return NextResponse.json({
      job: active ?? getDisplayEmbeddingJob(),
      pendingJobs: getPendingEmbeddingJobs(),
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
 * Returns immediately with the job record(s); progress via GET /api/search/status
 * or SSE GET /api/search/status/stream.
 *
 * `provider: "all-configured"` expands to one job per enabled+usable provider
 * for both saves and likes (queued behind any currently running job; skips
 * targets that already have a pending/running job).
 *
 * Concrete targets: `local` / `openai` / … (saves) or `likes-local` /
 * `likes-openai` / … (likes).
 */
export async function POST(request: Request) {
  const rejected = rejectUnlessLocalMutating(request);
  if (rejected) return rejected;

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
            "provider must be one of: local, ollama, openai, voyage, likes-local, likes-ollama, likes-openai, likes-voyage, all-configured",
        },
        { status: 400 },
      );
    }

    const result = startReindexJob(target);
    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.error,
          job: result.job ?? null,
          jobs: result.jobs ?? null,
        },
        { status: result.status },
      );
    }

    return NextResponse.json(
      { job: result.job, jobs: result.jobs },
      { status: 202 },
    );
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
