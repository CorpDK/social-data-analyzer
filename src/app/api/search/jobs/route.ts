import { NextResponse } from "next/server";
import { jsonInternalError, jsonPublicError } from "@/lib/api-error";
import { parseBoundedIntParam } from "@/lib/query-params";
import { ensureJobRunner } from "@/lib/search/jobs";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await getStorage();
    await ensureJobRunner();
    const storage = await getStorage();
    const { searchParams } = new URL(request.url);
    const limit = parseBoundedIntParam(searchParams.get("limit"), {
      name: "limit",
      defaultValue: 50,
      min: 1,
      max: 100,
    });
    if (!limit.ok) {
      return jsonPublicError(400, "INVALID_LIMIT", limit.error);
    }
    const offset = parseBoundedIntParam(searchParams.get("offset"), {
      name: "offset",
      defaultValue: 0,
      min: 0,
      max: 1_000_000,
    });
    if (!offset.ok) {
      return jsonPublicError(400, "INVALID_OFFSET", offset.error);
    }
    const result = await storage.jobs.listEmbeddingJobs({
      limit: limit.value,
      offset: offset.value,
    });
    return NextResponse.json(result);
  } catch (error) {
    return jsonInternalError("Failed to list embedding jobs", error, {
      code: "EMBEDDING_JOBS_LIST_FAILED",
      message: "Failed to list embedding jobs",
    });
  }
}
