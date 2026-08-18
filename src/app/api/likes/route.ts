import { NextResponse } from "next/server";
import { jsonPublicError } from "@/lib/api-error";
import { listLikes, listLikesFilterOptions } from "@/lib/queries";
import { parseBrowseFilterParams, parsePageParams } from "@/lib/query-params";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  if (searchParams.get("filters") === "1") {
    return NextResponse.json(listLikesFilterOptions());
  }

  const pageParams = parsePageParams(searchParams);
  if (!pageParams.ok) {
    return jsonPublicError(400, "INVALID_PAGE_PARAMS", pageParams.error);
  }

  const filters = parseBrowseFilterParams(searchParams, { library: "likes" });
  if (!filters.ok) {
    return jsonPublicError(400, "INVALID_FILTER_PARAMS", filters.error);
  }

  const data = await listLikes({
    q: filters.q,
    type: filters.type,
    author: filters.author,
    page: pageParams.page,
    pageSize: pageParams.pageSize,
    provider: filters.provider,
  });

  return NextResponse.json(data);
}
