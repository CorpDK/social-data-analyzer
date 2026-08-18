import { NextResponse } from "next/server";
import { jsonInternalError, jsonPublicError } from "@/lib/api-error";
import { rejectUnlessLocalMutating } from "@/lib/local-request-guard";
import {
  getSettingsKeysStatus,
  updateSettingsKeys,
  type UpdateSettingsKeysInput,
} from "@/lib/settings/credentials";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(getSettingsKeysStatus());
}

export async function PUT(request: Request) {
  const rejected = rejectUnlessLocalMutating(request);
  if (rejected) return rejected;

  let body: UpdateSettingsKeysInput;
  try {
    body = (await request.json()) as UpdateSettingsKeysInput;
  } catch {
    return jsonPublicError(400, "INVALID_JSON", "Invalid JSON body");
  }

  try {
    const status = updateSettingsKeys(body);
    return NextResponse.json(status);
  } catch (error) {
    // validateSettingsKeysInput / keyring throws intentional client messages.
    if (error instanceof Error) {
      return jsonPublicError(503, "SETTINGS_UPDATE_FAILED", error.message);
    }
    return jsonInternalError("Failed to update settings", error, {
      code: "SETTINGS_UPDATE_FAILED",
      message: "Failed to update settings",
      status: 503,
    });
  }
}

export async function POST(request: Request) {
  return PUT(request);
}
