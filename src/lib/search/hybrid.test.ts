import { describe, expect, it, vi, afterEach } from "vitest";
import { getSqlite } from "../db";
import {
  BROWSE_HYBRID_SEARCH_LIMIT,
  HYBRID_VEC_FETCH_K_MAX,
  searchFts,
  setHybridSearchWarnForTests,
} from "./hybrid";

vi.mock("../db", () => ({
  getSqlite: vi.fn(),
}));

describe("hybrid browse caps", () => {
  it("raises the former 500 browse/search ceiling for honest totals", () => {
    expect(BROWSE_HYBRID_SEARCH_LIMIT).toBe(10_000);
    expect(HYBRID_VEC_FETCH_K_MAX).toBe(4_096);
    expect(BROWSE_HYBRID_SEARCH_LIMIT).toBeGreaterThan(500);
  });
});

describe("hybrid search degrade logging", () => {
  afterEach(() => {
    setHybridSearchWarnForTests(null);
    vi.clearAllMocks();
  });

  it("logs a structured warning when FTS throws and returns empty degraded hits", () => {
    const warnings: string[] = [];
    setHybridSearchWarnForTests((message, error) => {
      warnings.push(
        `${message}${error instanceof Error ? `: ${error.message}` : ""}`,
      );
    });

    const sqlite = {
      prepare: () => ({
        all: () => {
          throw new Error("fts5: syntax error");
        },
      }),
    } as never;

    const result = searchFts("saves", "nature", 200, sqlite);
    expect(result.hits).toEqual([]);
    expect(result.degraded).toBe(true);
    expect(warnings[0]).toMatch(/FTS query failed \(saves\)/);
    expect(warnings[0]).toMatch(/fts5: syntax error/);
  });
});
