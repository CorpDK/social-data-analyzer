import { NextResponse } from "next/server";
import {
  discardImportInserts,
  ImportDiscardBusyError,
} from "@/lib/import/rollback-partial";
import { rejectUnlessLocalMutating } from "@/lib/local-request-guard";
import { getImportById } from "@/lib/queries";

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
    const { id: rawId } = await context.params;
    const id = Number(rawId);
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json({ error: "Invalid import id" }, { status: 400 });
    }

    const row = getImportById(id);
    if (!row) {
      return NextResponse.json({ error: "Import not found" }, { status: 404 });
    }

    const result = discardImportInserts(id);
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
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const message =
      error instanceof Error ? error.message : "Failed to discard import rows";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
