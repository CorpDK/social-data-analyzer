import { describe, expect, it, vi, afterEach } from "vitest";
import {
  jsonApiError,
  jsonInternalError,
  jsonPublicError,
} from "./api-error";

describe("api-error helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("jsonApiError returns status, code, and message", async () => {
    const res = jsonApiError(400, "INVALID_FILTER_PARAMS", "bad author");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "bad author",
      code: "INVALID_FILTER_PARAMS",
    });
  });

  it("jsonPublicError is an alias for intentional client messages", async () => {
    const res = jsonPublicError(409, "LIBRARY_BUSY", "import running");
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "import running",
      code: "LIBRARY_BUSY",
    });
  });

  it("jsonInternalError logs detail and never leaks exception text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = jsonInternalError(
      "Failed to heal search gaps",
      new Error("SQLITE_ERROR: secret path /tmp/xyz"),
    );
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: "An unexpected error occurred",
      code: "INTERNAL_ERROR",
    });
    expect(spy).toHaveBeenCalledWith(
      "Failed to heal search gaps",
      expect.any(Error),
    );
  });

  it("jsonInternalError accepts override code/message/status", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = jsonInternalError("boom", "x", {
      code: "HEAL_GAPS_FAILED",
      message: "Failed to heal search gaps",
      status: 503,
    });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Failed to heal search gaps",
      code: "HEAL_GAPS_FAILED",
    });
  });
});
