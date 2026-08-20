import { NextResponse } from "next/server";
import { jsonInternalError, jsonPublicError } from "@/lib/api-error";
import { rejectUnlessLocalMutating } from "@/lib/local-request-guard";
import { LibraryBusyError } from "@/lib/settings/library-busy";
import {
  getLibraryStatus,
  retryLibraryUpdate,
} from "@/lib/storage";
import {
  engineSwitchBusyMessage,
  isEngineSwitchRunning,
} from "@/lib/storage/engine-switch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getLibraryStatus());
}

export async function POST(request: Request) {
  const rejected = rejectUnlessLocalMutating(request);
  if (rejected) return rejected;

  if (isEngineSwitchRunning()) {
    return jsonPublicError(
      409,
      "LIBRARY_BUSY",
      engineSwitchBusyMessage("update the library"),
    );
  }

  try {
    return NextResponse.json(await retryLibraryUpdate());
  } catch (error) {
    if (error instanceof LibraryBusyError) {
      return jsonPublicError(409, "LIBRARY_BUSY", error.message);
    }
    return jsonInternalError("Library update retry failed", error, {
      code: "LIBRARY_UPDATE_FAILED",
      message: "We couldn't finish updating your library.",
      status: 503,
    });
  }
}
