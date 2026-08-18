import { describe, expect, it } from "vitest";
import { parseLibraryJobTarget } from "./library";

describe("parseLibraryJobTarget", () => {
  it("accepts the fts keyword-backfill target", () => {
    expect(parseLibraryJobTarget("fts")).toEqual({ kind: "fts" });
    expect(parseLibraryJobTarget("FTS")).toEqual({ kind: "fts" });
  });

  it("still parses provider and all-configured targets", () => {
    expect(parseLibraryJobTarget("local")).toEqual({
      kind: "provider",
      library: "saves",
      provider: "local",
    });
    expect(parseLibraryJobTarget("likes-voyage")).toEqual({
      kind: "provider",
      library: "likes",
      provider: "voyage",
    });
    expect(parseLibraryJobTarget("all-configured")).toEqual({
      kind: "all-configured",
    });
  });
});
