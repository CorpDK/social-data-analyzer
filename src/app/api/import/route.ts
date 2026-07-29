import { NextResponse } from "next/server";
import {
  importExportArchive,
  importExportJson,
} from "@/lib/import-export";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Upload a .zip or .json Instagram export file." },
        { status: 400 },
      );
    }

    const filename = file.name || "export.zip";
    const lower = filename.toLowerCase();
    const buffer = Buffer.from(await file.arrayBuffer());

    if (buffer.byteLength === 0) {
      return NextResponse.json({ error: "File is empty." }, { status: 400 });
    }

    // Cap at ~200MB for local tooling
    if (buffer.byteLength > 200 * 1024 * 1024) {
      return NextResponse.json(
        { error: "File is too large (max 200MB)." },
        { status: 400 },
      );
    }

    let result;
    if (lower.endsWith(".zip")) {
      result = importExportArchive(buffer, filename);
    } else if (lower.endsWith(".json")) {
      result = importExportJson(buffer.toString("utf8"), filename);
    } else {
      return NextResponse.json(
        { error: "Only .zip and .json exports are supported." },
        { status: 400 },
      );
    }

    const status =
      result.status === "failed" ? 422 : result.status === "duplicate" ? 200 : 201;

    return NextResponse.json(result, { status });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected import error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
