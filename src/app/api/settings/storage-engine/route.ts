import { NextResponse } from "next/server";
import { jsonInternalError, jsonPublicError } from "@/lib/api-error";
import { rejectUnlessLocalMutating } from "@/lib/local-request-guard";
import { readJsonObject } from "@/lib/request-json";
import {
  EngineSwitchError,
  getEngineSelectionStatus,
  startEngineMigration,
  switchToEmptyEngine,
} from "@/lib/storage/engine-switch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getEngineSelectionStatus());
  } catch (error) {
    return jsonInternalError("Failed to read storage engine status", error, {
      code: "ENGINE_STATUS_FAILED",
      message: "Failed to read storage engine status",
    });
  }
}

export async function POST(request: Request) {
  const rejected = rejectUnlessLocalMutating(request);
  if (rejected) return rejected;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) {
    return jsonPublicError(400, "INVALID_JSON", "Invalid JSON body");
  }

  const action = parsed.value.action;
  if (action !== "migrate" && action !== "fresh") {
    return jsonPublicError(
      400,
      "INVALID_ACTION",
      'Action must be "migrate" or "fresh".',
    );
  }

  try {
    const job =
      action === "migrate"
        ? await startEngineMigration(parsed.value)
        : await switchToEmptyEngine(parsed.value);
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    if (error instanceof EngineSwitchError) {
      return jsonPublicError(error.status, error.code, error.message);
    }
    return jsonInternalError("Failed to start storage engine switch", error, {
      code: "ENGINE_SWITCH_FAILED",
      message: "Failed to start storage engine switch",
    });
  }
}
