import { describe, expect, it } from "vitest";
import {
  readJsonBody,
  readJsonObject,
  readOptionalJobId,
} from "./request-json";

function jsonRequest(body: string, contentType = "application/json") {
  return new Request("http://127.0.0.1/api/test", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

describe("request-json", () => {
  it("readJsonBody accepts valid JSON", async () => {
    const result = await readJsonBody(jsonRequest('{"a":1}'));
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it("readJsonBody rejects invalid JSON", async () => {
    const result = await readJsonBody(jsonRequest("{nope"));
    expect(result).toEqual({ ok: false, reason: "invalid_json" });
  });

  it("readJsonObject rejects arrays and primitives", async () => {
    await expect(readJsonObject(jsonRequest("[1]"))).resolves.toEqual({
      ok: false,
      reason: "not_object",
    });
    await expect(readJsonObject(jsonRequest('"x"'))).resolves.toEqual({
      ok: false,
      reason: "not_object",
    });
    await expect(readJsonObject(jsonRequest('{"ok":true}'))).resolves.toEqual({
      ok: true,
      value: { ok: true },
    });
  });

  it("readOptionalJobId truncates finite numbers", () => {
    expect(readOptionalJobId({ jobId: 3.9 })).toBe(3);
    expect(readOptionalJobId({ jobId: "1" })).toBeUndefined();
    expect(readOptionalJobId(null)).toBeUndefined();
    expect(readOptionalJobId({})).toBeUndefined();
  });
});
