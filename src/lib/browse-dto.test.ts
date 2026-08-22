import { describe, expect, it } from "vitest";
import {
  parseBrowseFilterOptions,
  parseBrowseListResponse,
  parseSearchProviderInfo,
} from "./browse-dto";

describe("browse-dto guards", () => {
  it("parseBrowseFilterOptions accepts authors (± collections)", () => {
    expect(parseBrowseFilterOptions({ authors: ["a"] })).toEqual({
      authors: ["a"],
    });
    expect(
      parseBrowseFilterOptions({ authors: [], collections: ["c"] }),
    ).toEqual({ authors: [], collections: ["c"] });
    expect(parseBrowseFilterOptions({ authors: [1] })).toBeNull();
    expect(parseBrowseFilterOptions(null)).toBeNull();
  });

  it("parseSearchProviderInfo requires available/default/configured", () => {
    const ok = parseSearchProviderInfo({
      available: ["local", "ollama"],
      default: "local",
      configured: {
        local: true,
        ollama: false,
        openai: false,
        voyage: false,
      },
    });
    expect(ok?.default).toBe("local");
    expect(
      parseSearchProviderInfo({
        available: ["nope"],
        default: "local",
        configured: {
          local: true,
          ollama: false,
          openai: false,
          voyage: false,
        },
      }),
    ).toBeNull();
  });

  it("parseBrowseListResponse validates pagination envelope", () => {
    const ok = parseBrowseListResponse({
      items: [{ id: 1 }],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
      searchMode: "fts",
      totalCapped: false,
    });
    expect(ok?.items).toHaveLength(1);
    expect(ok?.searchMode).toBe("fts");
    expect(
      parseBrowseListResponse({
        items: "x",
        total: 1,
        page: 1,
        pageSize: 25,
        totalPages: 1,
      }),
    ).toBeNull();
  });

  it("preserves bidirectional membership DTOs", () => {
    const response = parseBrowseListResponse<{
      membership: { saved: boolean; liked: boolean };
    }>({
      items: [
        { membership: { saved: true, liked: true } },
        { membership: { saved: false, liked: true } },
      ],
      total: 2,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    });
    expect(response?.items.map((item) => item.membership)).toEqual([
      { saved: true, liked: true },
      { saved: false, liked: true },
    ]);
  });
});
