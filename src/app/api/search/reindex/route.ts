import { NextResponse } from "next/server";
import { jsonInternalError, jsonPublicError } from "@/lib/api-error";
import { rejectUnlessLocalMutating } from "@/lib/local-request-guard";
import { readJsonBody } from "@/lib/request-json";
import {
  ensureJobRunner,
  parseReindexTarget,
  startReindexJob,
} from "@/lib/search/jobs";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Current / latest reindex job progress (also included in GET /api/search/status). */
export async function GET() {
  try {
    const storage = await getStorage();
    await ensureJobRunner();
    const active = await storage.jobs.getActiveEmbeddingJob();
    return NextResponse.json({
      job: active ?? (await storage.jobs.getDisplayEmbeddingJob()),
      pendingJobs: await storage.jobs.getPendingEmbeddingJobs(),
      cancelSupported: true,
    });
  } catch (error) {
    return jsonInternalError("Failed to load reindex status", error, {
      code: "REINDEX_STATUS_FAILED",
      message: "Failed to load reindex status",
    });
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
    await getStorage();
    const parsed = await readJsonBody(request);
    if (!parsed.ok) {
      return jsonPublicError(400, "INVALID_JSON", "Invalid JSON body");
    }
    const body = parsed.value;

    const provider =
      body && typeof body === "object" && "provider" in body
        ? (body as { provider: unknown }).provider
        : undefined;

    const target = parseReindexTarget(provider);
    if (!target) {
      return jsonPublicError(
        400,
        "INVALID_REINDEX_TARGET",
        "provider must be one of: local, ollama, openai, voyage, likes-local, likes-ollama, likes-openai, likes-voyage, all-configured",
      );
    }

    const result = await startReindexJob(target);
    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.error,
          code: "REINDEX_REJECTED",
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
    return jsonInternalError("Failed to start reindex", error, {
      code: "REINDEX_START_FAILED",
      message: "Failed to start reindex",
    });
  }
}
