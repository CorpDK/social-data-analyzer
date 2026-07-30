import { NextResponse } from "next/server";
import { listLikes, listLikesFilterOptions } from "@/lib/queries";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  if (searchParams.get("filters") === "1") {
    return NextResponse.json(listLikesFilterOptions());
  }

  const data = await listLikes({
    q: searchParams.get("q") ?? undefined,
    type: searchParams.get("type") ?? undefined,
    author: searchParams.get("author") ?? undefined,
    page: Number(searchParams.get("page") ?? "1"),
    pageSize: Number(searchParams.get("pageSize") ?? "25"),
    provider: searchParams.get("provider") ?? undefined,
  });

  return NextResponse.json(data);
}
