import { describe, expect, it, vi, afterEach } from "vitest";
import { getSqlite } from "../db";
import {
  searchFts,
  setHybridSearchWarnForTests,
} from "./hybrid";

vi.mock("../db", () => ({
  getSqlite: vi.fn(),
}));

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

    vi.mocked(getSqlite).mockReturnValue({
      prepare: () => ({
        all: () => {
          throw new Error("fts5: syntax error");
        },
      }),
    } as never);

    const result = searchFts("saves", "nature");
    expect(result.hits).toEqual([]);
    expect(result.degraded).toBe(true);
    expect(warnings[0]).toMatch(/FTS query failed \(saves\)/);
    expect(warnings[0]).toMatch(/fts5: syntax error/);
  });
});
