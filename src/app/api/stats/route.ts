import { NextResponse } from "next/server";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET() {
  const storage = await getStorage();
  return NextResponse.json(await storage.catalog.getStats());
}
