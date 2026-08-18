import { describe, expect, it } from "vitest";
import {
  BROWSE_FILTER_BOUNDS,
  parseBoundedIntParam,
  parseBrowseFilterParams,
  parsePageParams,
} from "./query-params";

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

describe("parseBrowseFilterParams", () => {
  it("accepts normal saves filters", () => {
    const result = parseBrowseFilterParams(
      new URLSearchParams(
        "q=nature&type=reel&author=creator&collection=Food&provider=local",
      ),
      { library: "saves" },
    );
    expect(result).toEqual({
      ok: true,
      q: "nature",
      type: "reel",
      author: "creator",
      collection: "Food",
      provider: "local",
    });
  });

  it("rejects oversized q / author / collection", () => {
    const longQ = parseBrowseFilterParams(
      new URLSearchParams(`q=${"a".repeat(BROWSE_FILTER_BOUNDS.qMaxLen + 1)}`),
      { library: "saves" },
    );
    expect(longQ.ok).toBe(false);
    if (!longQ.ok) expect(longQ.error).toMatch(/q/i);

    const longAuthor = parseBrowseFilterParams(
      new URLSearchParams(
        `author=${"b".repeat(BROWSE_FILTER_BOUNDS.authorMaxLen + 1)}`,
      ),
      { library: "likes" },
    );
    expect(longAuthor.ok).toBe(false);

    const longCollection = parseBrowseFilterParams(
      new URLSearchParams(
        `collection=${"c".repeat(BROWSE_FILTER_BOUNDS.collectionMaxLen + 1)}`,
      ),
      { library: "saves" },
    );
    expect(longCollection.ok).toBe(false);
  });

  it("rejects unknown media types and accepts likes-only types", () => {
    const bad = parseBrowseFilterParams(new URLSearchParams("type=carousel"), {
      library: "saves",
    });
    expect(bad.ok).toBe(false);

    const storyOnSaves = parseBrowseFilterParams(
      new URLSearchParams("type=story"),
      { library: "saves" },
    );
    expect(storyOnSaves.ok).toBe(false);

    const storyOnLikes = parseBrowseFilterParams(
      new URLSearchParams("type=story"),
      { library: "likes" },
    );
    expect(storyOnLikes).toMatchObject({ ok: true, type: "story" });
  });

  it("ignores collection for likes library", () => {
    const result = parseBrowseFilterParams(
      new URLSearchParams("collection=Ignored"),
      { library: "likes" },
    );
    expect(result).toMatchObject({ ok: true, collection: undefined });
  });
});
