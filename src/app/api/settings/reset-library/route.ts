import { NextResponse } from "next/server";
import { rejectUnlessLocalMutating } from "@/lib/local-request-guard";
import {
  RESET_LIBRARY_CONFIRMATION_PHRASE,
  resetLibrary,
} from "@/lib/settings/reset-library";

export const runtime = "nodejs";

/**
 * Local single-user app — there is no multi-user auth gate. The typed
 * confirmation phrase is required in the body as a deliberate safeguard.
 * Mutating requests still pass the loopback Host/Origin (+ optional token) guard.
 */
export async function POST(request: Request) {
  const rejected = rejectUnlessLocalMutating(request);
  if (rejected) return rejected;

  let body: { confirmation?: unknown };
  try {
    body = (await request.json()) as { confirmation?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const confirmation =
    typeof body.confirmation === "string" ? body.confirmation : "";

  if (confirmation !== RESET_LIBRARY_CONFIRMATION_PHRASE) {
    return NextResponse.json(
      {
        error: `Confirmation phrase must be exactly "${RESET_LIBRARY_CONFIRMATION_PHRASE}"`,
      },
      { status: 400 },
    );
  }

  try {
    const result = resetLibrary(confirmation);
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to reset library";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
