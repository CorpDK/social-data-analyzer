import { NextResponse } from "next/server";
import { jsonInternalError, jsonPublicError } from "@/lib/api-error";
import { ImportDiscardBusyError } from "@/lib/import/rollback-partial";
import { rejectUnlessLocalMutating } from "@/lib/local-request-guard";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE rows introduced by this import (`first_seen_import_id`).
 * Residual last_seen-only updates are left for re-import reconciliation.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const rejected = rejectUnlessLocalMutating(request);
  if (rejected) return rejected;

  try {
    const storage = await getStorage();
    const { id: rawId } = await context.params;
    const id = Number(rawId);
    if (!Number.isFinite(id) || id <= 0) {
      return jsonPublicError(400, "INVALID_IMPORT_ID", "Invalid import id");
    }

    const row = await storage.catalog.getImportById(id);
    if (!row) {
      return jsonPublicError(404, "IMPORT_NOT_FOUND", "Import not found");
    }

    const result = await storage.catalog.discardImportInserts(id);
    return NextResponse.json({
      importId: id,
      savesDeleted: result.savesDeleted,
      likesDeleted: result.likesDeleted,
      residual: result.after,
      message:
        result.savesDeleted + result.likesDeleted === 0
          ? "No inserts from this import remained."
          : `Removed ${result.savesDeleted} save(s) and ${result.likesDeleted} like(s) introduced by this import.`,
    });
  } catch (error) {
    if (error instanceof ImportDiscardBusyError) {
      return jsonPublicError(409, "IMPORT_DISCARD_BUSY", error.message);
    }
    return jsonInternalError("Failed to discard import rows", error, {
      code: "IMPORT_DISCARD_FAILED",
      message: "Failed to discard import rows",
    });
  }
}
