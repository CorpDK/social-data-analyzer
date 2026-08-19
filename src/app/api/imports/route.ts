import { NextResponse } from "next/server";
import { listFilterOptions } from "@/lib/queries";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET() {
  const storage = await getStorage();
  const imports = await storage.catalog.listImports();
  return NextResponse.json({
    imports: imports.map((row) => ({
      ...row,
      importedAt: row.importedAt.toISOString(),
    })),
    filters: listFilterOptions(),
  });
}
