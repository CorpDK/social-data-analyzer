import { NextResponse } from "next/server";
import { listSaves } from "@/lib/queries";
import { parsePageParams } from "@/lib/query-params";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const pageParams = parsePageParams(searchParams);
  if (!pageParams.ok) {
    return NextResponse.json({ error: pageParams.error }, { status: 400 });
  }

  const data = await listSaves({
    q: searchParams.get("q") ?? undefined,
    type: searchParams.get("type") ?? undefined,
    author: searchParams.get("author") ?? undefined,
    collection: searchParams.get("collection") ?? undefined,
    page: pageParams.page,
    pageSize: pageParams.pageSize,
    provider: searchParams.get("provider") ?? undefined,
  });

  return NextResponse.json(data);
}
