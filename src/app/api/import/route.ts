import { NextResponse } from "next/server";
import {
  importExportArchive,
  importExportJson,
} from "@/lib/import-export";
import {
  IMPORT_MAX_FILE_BYTES,
  importFileTooLargeMessage,
} from "@/lib/import-limits";

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

    // Cap full Meta exports that include media (shared with client validation)
    if (file.size > IMPORT_MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: importFileTooLargeMessage() },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    if (buffer.byteLength === 0) {
      return NextResponse.json({ error: "File is empty." }, { status: 400 });
    }

    if (buffer.byteLength > IMPORT_MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: importFileTooLargeMessage() },
        { status: 400 },
      );
    }

    let result;
    if (lower.endsWith(".zip")) {
      result = await importExportArchive(buffer, filename);
    } else if (lower.endsWith(".json")) {
      result = await importExportJson(buffer.toString("utf8"), filename);
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
