import { describe, expect, it } from "vitest";
import {
  canonicalizeProviderQuery,
  formatBrowseTotal,
} from "./media-browser";

describe("MediaBrowser helpers", () => {
  it("omits the server default provider without changing a canonical query", () => {
    expect(canonicalizeProviderQuery("q=cats", "ollama", "ollama")).toBe(
      "q=cats",
    );
    expect(
      canonicalizeProviderQuery("q=cats&provider=ollama", "ollama", "ollama"),
    ).toBe("q=cats");
    expect(canonicalizeProviderQuery("q=cats", "local", "ollama")).toBe(
      "q=cats&provider=local",
    );
  });

  it("labels capped hybrid totals and their 10k window", () => {
    expect(
      formatBrowseTotal({
        total: 10_000,
        totalCapped: true,
        searchCap: 10_000,
      }),
    ).toBe("10,000+ items · top 10,000 matches");
    expect(formatBrowseTotal({ total: 1, totalCapped: false })).toBe("1 item");
  });
});
