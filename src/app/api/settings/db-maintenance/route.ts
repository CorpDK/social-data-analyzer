import { NextResponse } from "next/server";
import { jsonInternalError, jsonPublicError } from "@/lib/api-error";
import { rejectUnlessLocalMutating } from "@/lib/local-request-guard";
import { readJsonObject } from "@/lib/request-json";
import { LibraryBusyError, parseDbMaintenanceAction } from "@/lib/settings/db-maintenance";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Local single-user WAL checkpoint / VACUUM. Refuses (409) while import or
 * embedding jobs are pending/running. Mutating requests still pass the
 * loopback Host/Origin (+ optional token) guard.
 */
export async function POST(request: Request) {
  const rejected = rejectUnlessLocalMutating(request);
  if (rejected) return rejected;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) {
    return jsonPublicError(400, "INVALID_JSON", "Invalid JSON body");
  }

  const action = parseDbMaintenanceAction(parsed.value.action);
  if (!action) {
    return jsonPublicError(
      400,
      "INVALID_ACTION",
      'Body must include action: "checkpoint" or "vacuum"',
    );
  }

  try {
    const storage = await getStorage();
    const result = await storage.maintenance.runMaintenance(action);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof LibraryBusyError) {
      return jsonPublicError(409, "LIBRARY_BUSY", error.message);
    }
    return jsonInternalError("Database maintenance failed", error, {
      code: "DB_MAINTENANCE_FAILED",
      message: "Database maintenance failed",
    });
  }
}
