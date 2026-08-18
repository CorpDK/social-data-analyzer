/**
 * Streaming multipart upload → spool without buffering the full body.
 *
 * Parses a single `file` part from `multipart/form-data`, writing bytes
 * directly to disk while hashing and enforcing a size cap.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  IMPORT_MAX_FILE_BYTES,
  importFileTooLargeMessage,
  importKindFromFilename,
  importMaxBytesForKind,
  type ImportUploadKind,
} from "../import-limits";
import { ensureImportSpoolDir, type SpoolWriteResult } from "./spool";

export type MultipartSpoolResult = {
  filename: string;
  kind: ImportUploadKind;
  spool: SpoolWriteResult;
};

export class MultipartUploadError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "MultipartUploadError";
    this.status = status;
  }
}

function parseBoundary(contentType: string | null): string {
  if (!contentType) {
    throw new MultipartUploadError(
      "Content-Type must be multipart/form-data.",
      415,
    );
  }
  const match = /boundary=(?:"([^"]+)"|([^;,\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) {
    throw new MultipartUploadError(
      "multipart/form-data boundary is missing.",
      400,
    );
  }
  return boundary;
}

function headerValue(
  headers: string,
  name: string,
): string | undefined {
  const re = new RegExp(`^${name}:\\s*(.+)$`, "im");
  const m = re.exec(headers);
  return m?.[1]?.trim();
}

function parseContentDisposition(value: string | undefined): {
  name: string | null;
  filename: string | null;
} {
  if (!value) return { name: null, filename: null };
  const nameMatch = /(?:^|;)\s*name=(?:"([^"]*)"|([^;]*))/i.exec(value);
  const fileMatch = /(?:^|;)\s*filename\*=(?:UTF-8'')?([^;]+)|(?:^|;)\s*filename=(?:"([^"]*)"|([^;]*))/i.exec(
    value,
  );
  const name = (nameMatch?.[1] ?? nameMatch?.[2] ?? null)?.trim() ?? null;
  let filename =
    (fileMatch?.[1] ?? fileMatch?.[2] ?? fileMatch?.[3] ?? null)?.trim() ??
    null;
  if (filename) {
    try {
      filename = decodeURIComponent(filename.replace(/^"|"$/g, ""));
    } catch {
      filename = filename.replace(/^"|"$/g, "");
    }
  }
  return { name, filename };
}

/**
 * Transform that strips multipart framing and emits only the first matching
 * file field body. Enforces maxBytes while counting.
 */
class MultipartFileExtract extends Transform {
  private buffer = Buffer.alloc(0);
  private readonly boundary: Buffer;
  private readonly endBoundary: Buffer;
  private readonly fieldName: string;
  private phase:
    | "preamble"
    | "headers"
    | "body"
    | "skip-part"
    | "done" = "preamble";
  private filename: string | null = null;
  private byteLength = 0;
  private readonly maxBytes: number;
  private readonly tooLargeMessage: string;
  private sawFile = false;
  private bodyEnded = false;

  constructor(opts: {
    boundary: string;
    fieldName: string;
    maxBytes: number;
    tooLargeMessage: string;
  }) {
    super();
    this.boundary = Buffer.from(`--${opts.boundary}`);
    this.endBoundary = Buffer.from(`--${opts.boundary}--`);
    this.fieldName = opts.fieldName;
    this.maxBytes = opts.maxBytes;
    this.tooLargeMessage = opts.tooLargeMessage;
  }

  getFilename(): string | null {
    return this.filename;
  }

  getByteLength(): number {
    return this.byteLength;
  }

  didReceiveFile(): boolean {
    return this.sawFile;
  }

  _transform(
    chunk: Buffer,
    _enc: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.consume();
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  _flush(callback: TransformCallback): void {
    try {
      this.consume(true);
      if (!this.sawFile) {
        callback(
          new MultipartUploadError(
            "Upload a .zip or .json Instagram export file.",
          ),
        );
        return;
      }
      if (!this.bodyEnded) {
        callback(new MultipartUploadError("Incomplete multipart upload."));
        return;
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private consume(flushing = false): void {
    while (this.phase !== "done") {
      if (this.phase === "preamble") {
        const idx = this.indexOfBoundary();
        if (idx < 0) {
          // Keep a small tail in case the boundary straddles chunks.
          if (this.buffer.length > this.boundary.length + 8) {
            this.buffer = this.buffer.subarray(
              this.buffer.length - (this.boundary.length + 8),
            );
          }
          if (flushing) {
            throw new MultipartUploadError("Incomplete multipart upload.");
          }
          return;
        }
        // Skip boundary line ending
        let after = idx + this.boundary.length;
        if (this.buffer.subarray(after, after + 2).equals(Buffer.from("\r\n"))) {
          after += 2;
        } else if (this.buffer[after] === 0x0a) {
          after += 1;
        }
        this.buffer = this.buffer.subarray(after);
        this.phase = "headers";
        continue;
      }

      if (this.phase === "headers") {
        const sep = this.buffer.indexOf("\r\n\r\n");
        if (sep < 0) {
          if (flushing) {
            throw new MultipartUploadError("Incomplete multipart headers.");
          }
          return;
        }
        const headerText = this.buffer.subarray(0, sep).toString("utf8");
        this.buffer = this.buffer.subarray(sep + 4);
        const disposition = headerValue(headerText, "Content-Disposition");
        const { name, filename } = parseContentDisposition(disposition);
        if (name === this.fieldName && filename) {
          this.filename = filename;
          this.sawFile = true;
          this.phase = "body";
          continue;
        }
        // Skip non-file / wrong field — find next boundary
        this.phase = "skip-part";
        continue;
      }

      if (this.phase === "skip-part") {
        const idx = this.indexOfBoundary();
        if (idx < 0) {
          if (this.buffer.length > this.boundary.length + 8) {
            this.buffer = this.buffer.subarray(
              this.buffer.length - (this.boundary.length + 8),
            );
          }
          if (flushing) {
            throw new MultipartUploadError(
              "Upload a .zip or .json Instagram export file.",
            );
          }
          return;
        }
        let after = idx;
        // Include leading CRLF before boundary if present
        if (
          after >= 2 &&
          this.buffer[after - 2] === 0x0d &&
          this.buffer[after - 1] === 0x0a
        ) {
          // boundary search already at --boundary
        }
        after += this.boundary.length;
        if (this.buffer.subarray(after, after + 2).equals(Buffer.from("--"))) {
          this.phase = "done";
          this.buffer = Buffer.alloc(0);
          return;
        }
        if (this.buffer.subarray(after, after + 2).equals(Buffer.from("\r\n"))) {
          after += 2;
        }
        this.buffer = this.buffer.subarray(after);
        this.phase = "headers";
        continue;
      }

      if (this.phase === "body") {
        const idx = this.indexOfBoundary();
        if (idx < 0) {
          // Emit all but trailing potential boundary-sized window
          const keep = this.boundary.length + 4;
          if (this.buffer.length > keep) {
            const emitLen = this.buffer.length - keep;
            this.emitBody(this.buffer.subarray(0, emitLen));
            this.buffer = this.buffer.subarray(emitLen);
          }
          if (flushing) {
            throw new MultipartUploadError("Incomplete multipart upload.");
          }
          return;
        }
        // Body ends at CRLF before boundary
        let end = idx;
        if (
          end >= 2 &&
          this.buffer[end - 2] === 0x0d &&
          this.buffer[end - 1] === 0x0a
        ) {
          end -= 2;
        }
        if (end > 0) {
          this.emitBody(this.buffer.subarray(0, end));
        }
        this.bodyEnded = true;
        this.phase = "done";
        this.buffer = Buffer.alloc(0);
        return;
      }
    }
  }

  private indexOfBoundary(): number {
    // Prefer end-boundary match for correctness when both share prefix
    const endIdx = this.buffer.indexOf(this.endBoundary);
    const idx = this.buffer.indexOf(this.boundary);
    if (idx < 0) return -1;
    if (endIdx >= 0 && endIdx <= idx) return endIdx;
    return idx;
  }

  private emitBody(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.byteLength += chunk.length;
    if (this.byteLength > this.maxBytes) {
      throw new MultipartUploadError(this.tooLargeMessage, 413);
    }
    this.push(chunk);
  }
}

/**
 * Stream the request body multipart `file` field straight to a spool path.
 */
export async function spoolMultipartFileUpload(
  request: Request,
  options?: {
    fieldName?: string;
    jobToken?: string;
    /** Cap before kind is known (uses max of zip/json). */
    provisionalMaxBytes?: number;
  },
): Promise<MultipartSpoolResult> {
  const contentType = request.headers.get("content-type");
  const boundary = parseBoundary(contentType);
  const fieldName = options?.fieldName ?? "file";
  const provisionalMax =
    options?.provisionalMaxBytes ?? IMPORT_MAX_FILE_BYTES;

  if (!request.body) {
    throw new MultipartUploadError("Empty request body.");
  }

  const jobToken =
    options?.jobToken ??
    `${Date.now()}-${randomBytes(6).toString("hex")}`;
  const dir = ensureImportSpoolDir();
  const tempName = `${jobToken}.part`;
  const spoolPath = path.join(dir, tempName);

  const hash = createHash("sha256");
  let hashed = 0;

  const extract = new MultipartFileExtract({
    boundary,
    fieldName,
    maxBytes: provisionalMax,
    tooLargeMessage: importFileTooLargeMessage("zip"),
  });

  const hasher = new Transform({
    transform(chunk, _enc, cb) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hashed += buf.byteLength;
      hash.update(buf);
      cb(null, buf);
    },
  });

  const nodeReadable = Readable.fromWeb(
    request.body as import("node:stream/web").ReadableStream,
  );

  try {
    await pipeline(
      nodeReadable,
      extract,
      hasher,
      fs.createWriteStream(spoolPath),
    );
  } catch (error) {
    try {
      if (fs.existsSync(spoolPath)) fs.unlinkSync(spoolPath);
    } catch {
      // best-effort
    }
    throw error;
  }

  const filename = extract.getFilename() || "export.bin";
  const kind = importKindFromFilename(filename);
  if (!kind) {
    try {
      fs.unlinkSync(spoolPath);
    } catch {
      // ignore
    }
    throw new MultipartUploadError(
      "Only .zip and .json exports are supported.",
    );
  }

  const maxBytes = importMaxBytesForKind(kind);
  if (hashed > maxBytes) {
    try {
      fs.unlinkSync(spoolPath);
    } catch {
      // ignore
    }
    throw new MultipartUploadError(importFileTooLargeMessage(kind), 413);
  }

  if (hashed === 0) {
    try {
      fs.unlinkSync(spoolPath);
    } catch {
      // ignore
    }
    throw new MultipartUploadError("File is empty.");
  }

  const safeName = filename.replace(/[^\w.\-]+/g, "_");
  const finalPath = path.join(dir, `${jobToken}-${safeName}`);
  fs.renameSync(spoolPath, finalPath);

  return {
    filename,
    kind,
    spool: {
      spoolPath: finalPath,
      contentHash: hash.digest("hex"),
      byteLength: hashed,
    },
  };
}
