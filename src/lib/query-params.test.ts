import { describe, expect, it } from "vitest";
import { parseBoundedIntParam, parsePageParams } from "./query-params";

describe("parseBoundedIntParam", () => {
  it("uses default for null / blank", () => {
    expect(
      parseBoundedIntParam(null, {
        name: "page",
        defaultValue: 1,
        min: 1,
        max: 10,
      }),
    ).toEqual({ ok: true, value: 1 });
    expect(
      parseBoundedIntParam("  ", {
        name: "page",
        defaultValue: 3,
        min: 1,
        max: 10,
      }),
    ).toEqual({ ok: true, value: 3 });
  });

  it("rejects non-integers and out-of-range", () => {
    expect(
      parseBoundedIntParam("abc", {
        name: "page",
        defaultValue: 1,
        min: 1,
        max: 10,
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseBoundedIntParam("1.5", {
        name: "page",
        defaultValue: 1,
        min: 1,
        max: 10,
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseBoundedIntParam("0", {
        name: "page",
        defaultValue: 1,
        min: 1,
        max: 10,
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseBoundedIntParam("11", {
        name: "page",
        defaultValue: 1,
        min: 1,
        max: 10,
      }),
    ).toMatchObject({ ok: false });
  });

  it("accepts finite integers in range", () => {
    expect(
      parseBoundedIntParam("7", {
        name: "pageSize",
        defaultValue: 25,
        min: 1,
        max: 100,
      }),
    ).toEqual({ ok: true, value: 7 });
  });
});

describe("parsePageParams", () => {
  it("defaults page and pageSize", () => {
    expect(parsePageParams(new URLSearchParams())).toEqual({
      ok: true,
      page: 1,
      pageSize: 25,
    });
  });

  it("returns error for malformed page or pageSize (never NaN)", () => {
    const badPage = parsePageParams(new URLSearchParams("page=NaN"));
    expect(badPage.ok).toBe(false);
    if (!badPage.ok) expect(badPage.error).toMatch(/page/i);

    const badSize = parsePageParams(new URLSearchParams("pageSize=oops"));
    expect(badSize.ok).toBe(false);
    if (!badSize.ok) expect(badSize.error).toMatch(/pageSize/i);
  });
});
