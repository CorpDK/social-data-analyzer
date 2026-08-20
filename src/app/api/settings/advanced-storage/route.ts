import { NextResponse } from "next/server";
import { jsonPublicError } from "@/lib/api-error";
import { rejectUnlessLocalMutating } from "@/lib/local-request-guard";
import { readJsonObject } from "@/lib/request-json";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const storage = await getStorage();
  const stored =
    (await storage.settings.getAppSetting("postgres_advanced_enabled")) === "1";
  return NextResponse.json({
    enabled: Boolean(process.env.INSTAGRAM_SAVES_DATABASE_URL?.trim()) || stored,
    lockedByEnvironment: Boolean(
      process.env.INSTAGRAM_SAVES_DATABASE_URL?.trim(),
    ),
  });
}

export async function POST(request: Request) {
  const rejected = rejectUnlessLocalMutating(request);
  if (rejected) return rejected;

  const parsed = await readJsonObject(request);
  if (!parsed.ok || typeof parsed.value.enabled !== "boolean") {
    return jsonPublicError(
      400,
      "INVALID_ADVANCED_STORAGE_SETTING",
      "Body must include an enabled boolean.",
    );
  }

  const storage = await getStorage();
  await storage.settings.setAppSetting(
    "postgres_advanced_enabled",
    parsed.value.enabled ? "1" : null,
  );
  return NextResponse.json({ enabled: parsed.value.enabled });
}
