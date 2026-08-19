import { NextResponse } from "next/server";
import { jsonInternalError, jsonPublicError } from "@/lib/api-error";
import { rejectUnlessLocalMutating } from "@/lib/local-request-guard";
import { readJsonBody } from "@/lib/request-json";
import {
  getSettingsKeysStatus,
  updateSettingsKeys,
  type UpdateSettingsKeysInput,
} from "@/lib/settings/credentials";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET() {
  await getStorage();
  return NextResponse.json(getSettingsKeysStatus());
}

export async function PUT(request: Request) {
  const rejected = rejectUnlessLocalMutating(request);
  if (rejected) return rejected;

  await getStorage();
  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return jsonPublicError(400, "INVALID_JSON", "Invalid JSON body");
  }
  const body = parsed.value as UpdateSettingsKeysInput;

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
