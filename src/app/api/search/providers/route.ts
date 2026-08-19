import { NextResponse } from "next/server";
import { getProviderAvailability } from "@/lib/search/providers";
import type { SearchLibrary } from "@/lib/search/library";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";

function parseLibrary(raw: string | null): SearchLibrary {
  return raw === "likes" ? "likes" : "saves";
}

export async function GET(request: Request) {
  await getStorage();
  const { searchParams } = new URL(request.url);
  const library = parseLibrary(searchParams.get("library"));
  return NextResponse.json(getProviderAvailability(library));
}
