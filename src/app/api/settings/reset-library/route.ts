import { NextResponse } from "next/server";
import { jsonInternalError, jsonPublicError } from "@/lib/api-error";
import { rejectUnlessLocalMutating } from "@/lib/local-request-guard";
import {
  LibraryBusyError,
  RESET_LIBRARY_CONFIRMATION_PHRASE,
  resetLibrary,
} from "@/lib/settings/reset-library";

export const runtime = "nodejs";

/**
 * Local single-user app — there is no multi-user auth gate. The typed
 * confirmation phrase is required in the body as a deliberate safeguard.
 * Mutating requests still pass the loopback Host/Origin (+ optional token) guard.
 * Returns 409 when import/embedding jobs are still pending or running.
 */
export async function POST(request: Request) {
  const rejected = rejectUnlessLocalMutating(request);
  if (rejected) return rejected;

  let body: { confirmation?: unknown };
  try {
    body = (await request.json()) as { confirmation?: unknown };
  } catch {
    return jsonPublicError(400, "INVALID_JSON", "Invalid JSON body");
  }

  const confirmation =
    typeof body.confirmation === "string" ? body.confirmation : "";

  if (confirmation !== RESET_LIBRARY_CONFIRMATION_PHRASE) {
    return jsonPublicError(
      400,
      "CONFIRMATION_REQUIRED",
      `Confirmation phrase must be exactly "${RESET_LIBRARY_CONFIRMATION_PHRASE}"`,
    );
  }

  try {
    const result = resetLibrary(confirmation);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof LibraryBusyError) {
      return jsonPublicError(409, "LIBRARY_BUSY", error.message);
    }
    return jsonInternalError("Failed to reset library", error, {
      code: "RESET_LIBRARY_FAILED",
      message: "Failed to reset library",
    });
  }
}
