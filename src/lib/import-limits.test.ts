import { describe, expect, it } from "vitest";
import {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_FILE_LABEL,
  IMPORT_MAX_FILE_SIZE_LIMIT,
  IMPORT_MAX_JSON_FILE_BYTES,
  IMPORT_MAX_JSON_FILE_LABEL,
  importFileTooLargeMessage,
  importJsonFileTooLargeMessage,
  importKindFromFilename,
  importMaxBytesForKind,
} from "./import-limits";

describe("import-limits", () => {
  it("keeps zip multipart cap at 512MiB with streaming messaging", () => {
    expect(IMPORT_MAX_FILE_BYTES).toBe(512 * 1024 * 1024);
    expect(IMPORT_MAX_FILE_LABEL).toBe("512MB");
    expect(IMPORT_MAX_FILE_SIZE_LIMIT).toBe("512mb");
  });

  it("uses a dedicated JSON cap with Node string-limit messaging", () => {
    expect(IMPORT_MAX_JSON_FILE_BYTES).toBe(512 * 1024 * 1024);
    expect(IMPORT_MAX_JSON_FILE_LABEL).toBe("512MB");
    expect(importMaxBytesForKind("json")).toBe(IMPORT_MAX_JSON_FILE_BYTES);
    expect(importMaxBytesForKind("zip")).toBe(IMPORT_MAX_FILE_BYTES);
    expect(importJsonFileTooLargeMessage()).toMatch(/Node\/V8 string/i);
    expect(importFileTooLargeMessage("json")).toMatch(/JSON export is too large/);
    expect(importFileTooLargeMessage("zip")).toMatch(/stream to disk/i);
  });

  it("infers upload kind from filename", () => {
    expect(importKindFromFilename("export.ZIP")).toBe("zip");
    expect(importKindFromFilename("saved_posts.json")).toBe("json");
    expect(importKindFromFilename("notes.txt")).toBeNull();
  });
});
