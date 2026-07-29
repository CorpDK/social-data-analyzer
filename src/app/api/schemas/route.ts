import { NextResponse } from "next/server";
import { getSchemaCatalog } from "@/lib/schema-catalog";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const importId = searchParams.get("importId") ?? "all";
  const catalog = getSchemaCatalog(importId);

  return NextResponse.json({
    mode: catalog.mode,
    importId: catalog.importId,
    emptyReason: catalog.emptyReason,
    imports: catalog.imports.map((row) => ({
      ...row,
      importedAt: row.importedAt.toISOString(),
    })),
    files: catalog.files,
  });
}
