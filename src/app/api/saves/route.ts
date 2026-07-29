import { NextResponse } from "next/server";
import { listSaves } from "@/lib/queries";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const data = listSaves({
    q: searchParams.get("q") ?? undefined,
    type: searchParams.get("type") ?? undefined,
    author: searchParams.get("author") ?? undefined,
    collection: searchParams.get("collection") ?? undefined,
    page: Number(searchParams.get("page") ?? "1"),
    pageSize: Number(searchParams.get("pageSize") ?? "25"),
  });

  return NextResponse.json(data);
}
