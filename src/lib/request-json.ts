/**
 * Shared JSON body readers for API routes.
 * Prefer these over bare `request.json() as T` so invalid JSON and non-objects
 * fail as validation errors instead of type assertions.
 */

export type JsonBodyOk<T = unknown> = { ok: true; value: T };
export type JsonBodyErr = { ok: false; reason: "invalid_json" | "not_object" };

export async function readJsonBody(
  request: Request,
): Promise<JsonBodyOk | JsonBodyErr> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

/** Parse a JSON object body; arrays and primitives are rejected. */
export async function readJsonObject(
  request: Request,
): Promise<JsonBodyOk<Record<string, unknown>> | JsonBodyErr> {
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed;
  if (
    !parsed.value ||
    typeof parsed.value !== "object" ||
    Array.isArray(parsed.value)
  ) {
    return { ok: false, reason: "not_object" };
  }
  return { ok: true, value: parsed.value as Record<string, unknown> };
}

/** Optional finite job id from a body object (empty / missing → undefined). */
export function readOptionalJobId(body: unknown): number | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const jobId = (body as { jobId?: unknown }).jobId;
  if (typeof jobId === "number" && Number.isFinite(jobId)) {
    return Math.trunc(jobId);
  }
  return undefined;
}
