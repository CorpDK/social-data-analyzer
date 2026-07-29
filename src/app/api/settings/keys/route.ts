import { NextResponse } from "next/server";
import {
  getSettingsKeysStatus,
  updateSettingsKeys,
  type UpdateSettingsKeysInput,
} from "@/lib/settings/credentials";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(getSettingsKeysStatus());
}

export async function PUT(request: Request) {
  let body: UpdateSettingsKeysInput;
  try {
    body = (await request.json()) as UpdateSettingsKeysInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const status = updateSettingsKeys(body);
    return NextResponse.json(status);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update settings";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

export async function POST(request: Request) {
  return PUT(request);
}
