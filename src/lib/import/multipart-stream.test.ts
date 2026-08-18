import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MultipartUploadError,
  spoolMultipartFileUpload,
} from "./multipart-stream";

function buildMultipart(
  filename: string,
  body: Buffer | string,
  fieldName = "file",
): { contentType: string; body: Buffer } {
  const boundary = `----test${randomBytes(4).toString("hex")}`;
  const fileBody = typeof body === "string" ? Buffer.from(body) : body;
  const parts = [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n`,
    `Content-Type: application/octet-stream\r\n\r\n`,
  ];
  const header = Buffer.from(parts.join(""));
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([header, fileBody, footer]),
  };
}

describe("spoolMultipartFileUpload", () => {
  it("streams a zip field to a spool path without formData buffering", async () => {
    const prevCwd = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ig-multipart-"));
    process.chdir(tmp);
    try {
      const payload = buildMultipart("sample.zip", "PK\x03\x04fake-zip-bytes");
      const request = new Request("http://127.0.0.1/api/import", {
        method: "POST",
        headers: { "content-type": payload.contentType },
        body: new Uint8Array(payload.body),
      });

      const result = await spoolMultipartFileUpload(request, {
        provisionalMaxBytes: 1024 * 1024,
        jobToken: "tok1",
      });

      expect(result.kind).toBe("zip");
      expect(result.filename).toBe("sample.zip");
      expect(result.spool.byteLength).toBeGreaterThan(0);
      expect(fs.existsSync(result.spool.spoolPath)).toBe(true);
      expect(fs.readFileSync(result.spool.spoolPath).equals(Buffer.from("PK\x03\x04fake-zip-bytes"))).toBe(
        true,
      );
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects non zip/json filenames", async () => {
    const prevCwd = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ig-multipart-"));
    process.chdir(tmp);
    try {
      const payload = buildMultipart("notes.txt", "hello");
      const request = new Request("http://127.0.0.1/api/import", {
        method: "POST",
        headers: { "content-type": payload.contentType },
        body: new Uint8Array(payload.body),
      });
      await expect(
        spoolMultipartFileUpload(request, { provisionalMaxBytes: 1024 }),
      ).rejects.toBeInstanceOf(MultipartUploadError);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
