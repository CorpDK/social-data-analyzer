import { describe, expect, it } from "vitest";
import {
  BROWSE_HYBRID_SEARCH_LIMIT,
  HYBRID_VEC_FETCH_K_MAX,
} from "./hybrid";
import { searchSqliteFts } from "../storage/sqlite/search-query";

describe("hybrid browse caps", () => {
  it("raises the former 500 browse/search ceiling for honest totals", () => {
    expect(BROWSE_HYBRID_SEARCH_LIMIT).toBe(10_000);
    expect(HYBRID_VEC_FETCH_K_MAX).toBe(4_096);
    expect(BROWSE_HYBRID_SEARCH_LIMIT).toBeGreaterThan(500);
  });
});

describe("hybrid search degrade logging", () => {
  it("logs a structured warning when FTS throws and returns empty degraded hits", () => {
    const sqlite = {
      prepare: () => ({
        all: () => {
          throw new Error("fts5: syntax error");
        },
      }),
    } as never;

    const result = searchSqliteFts(sqlite, "saves", "nature", 200);
    expect(result.hits).toEqual([]);
    expect(result.degraded).toBe(true);
  });
});
