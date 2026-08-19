import { NextResponse } from "next/server";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const storage = await getStorage();
  const { searchParams } = new URL(request.url);
  const importId = searchParams.get("importId") ?? "all";
  const catalog = await storage.catalog.getSchemaCatalog(importId);

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
