import { NextResponse } from "next/server";
import { listFilterOptions, listImports } from "@/lib/queries";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    imports: listImports().map((row) => ({
      ...row,
      importedAt: row.importedAt.toISOString(),
    })),
    filters: listFilterOptions(),
  });
}
