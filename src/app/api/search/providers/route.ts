import { NextResponse } from "next/server";
import { getProviderAvailability } from "@/lib/search/providers";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(getProviderAvailability());
}
