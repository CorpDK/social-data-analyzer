import { NextResponse } from "next/server";
import { jsonPublicError } from "@/lib/api-error";
import { parseBrowseFilterParams, parsePageParams } from "@/lib/query-params";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const storage = await getStorage();
  const { searchParams } = new URL(request.url);

  if (searchParams.get("filters") === "1") {
    return NextResponse.json(await storage.catalog.listLikesFilterOptions());
  }

  const pageParams = parsePageParams(searchParams);
  if (!pageParams.ok) {
    return jsonPublicError(400, "INVALID_PAGE_PARAMS", pageParams.error);
  }

  const filters = parseBrowseFilterParams(searchParams, { library: "likes" });
  if (!filters.ok) {
    return jsonPublicError(400, "INVALID_FILTER_PARAMS", filters.error);
  }

  const data = await storage.catalog.listLikes({
    q: filters.q,
    type: filters.type,
    author: filters.author,
    page: pageParams.page,
    pageSize: pageParams.pageSize,
    provider: filters.provider,
  });

  return NextResponse.json(data);
}
