import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import {
  IMPORT_MAX_FILE_BYTES,
  importFileTooLargeMessage,
} from "../import-limits";

const dataDir = path.join(process.cwd(), "data");

/** Spool directory for uploaded export files awaiting / undergoing import. */
export function importSpoolDir(): string {
  return path.join(dataDir, "imports");
}

export function ensureImportSpoolDir(): string {
  const dir = importSpoolDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export type SpoolWriteResult = {
  spoolPath: string;
  contentHash: string;
  byteLength: number;
};

/**
 * Stream a browser File to a unique spool path while hashing and enforcing
 * the max upload size. Does not keep the full payload in a single Buffer.
 */
export async function spoolUploadedFile(
  file: File,
  jobToken: string,
): Promise<SpoolWriteResult> {
  const dir = ensureImportSpoolDir();
  const safeName = (file.name || "export.bin").replace(/[^\w.\-]+/g, "_");
  const spoolPath = path.join(dir, `${jobToken}-${safeName}`);

  const hash = createHash("sha256");
  let byteLength = 0;

  const counter = new Transform({
    transform(chunk, _enc, callback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buf.byteLength;
      if (byteLength > IMPORT_MAX_FILE_BYTES) {
        callback(new Error(importFileTooLargeMessage()));
        return;
      }
      hash.update(buf);
      callback(null, buf);
    },
  });

  const webStream = file.stream();
  const nodeReadable = Readable.fromWeb(
    webStream as import("node:stream/web").ReadableStream,
  );

  try {
    await pipeline(nodeReadable, counter, fs.createWriteStream(spoolPath));
  } catch (error) {
    try {
      if (fs.existsSync(spoolPath)) fs.unlinkSync(spoolPath);
    } catch {
      // best-effort cleanup
    }
    throw error;
  }

  if (byteLength === 0) {
    try {
      fs.unlinkSync(spoolPath);
    } catch {
      // ignore
    }
    throw new Error("File is empty.");
  }

  return {
    spoolPath,
    contentHash: hash.digest("hex"),
    byteLength,
  };
}

export function readSpoolFile(spoolPath: string): Buffer {
  return fs.readFileSync(spoolPath);
}

export function deleteSpoolFile(spoolPath: string | null | undefined) {
  if (!spoolPath) return;
  try {
    if (fs.existsSync(spoolPath)) fs.unlinkSync(spoolPath);
  } catch {
    // best-effort
  }
}

/** Remove every file under data/imports/ (used by reset-library). */
export function clearImportSpool() {
  const dir = importSpoolDir();
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      // ignore locked/missing
    }
  }
}
