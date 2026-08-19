import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db", () => ({
  getSqlite: vi.fn(),
}));

vi.mock("./sync-fts", () => ({
  ftsCount: vi.fn(),
}));

vi.mock("./sync-vec-store", () => ({
  vecCount: vi.fn(),
  vectorIndexMatchesConfig: vi.fn(),
}));

vi.mock("./embeddings", () => ({
  localEmbeddingConfig: vi.fn(() => ({ profile: { model: "local" } })),
}));

vi.mock("./providers", () => ({
  isProviderConfigured: vi.fn(),
}));

vi.mock("./jobs", () => ({
  ensureJobRunner: vi.fn(),
  enqueueFtsBackfillJob: vi.fn(),
  hasOpenEmbeddingJobForTarget: vi.fn(() => false),
  startReindexJob: vi.fn(() => ({ ok: true, job: { id: 1 }, jobs: [] })),
}));

import { getSqlite } from "../db";
import { ftsCount } from "./sync-fts";
import { vecCount, vectorIndexMatchesConfig } from "./sync-vec-store";
import { isProviderConfigured } from "./providers";
import {
  enqueueFtsBackfillJob,
  hasOpenEmbeddingJobForTarget,
  startReindexJob,
} from "./jobs";
import {
  assessSearchIndexGaps,
  resetSearchBackfillScheduleLatchForTests,
  scheduleSearchBackfillJobsIfNeeded,
} from "./readiness";

function mockCounts(opts: {
  saves: number;
  likes: number;
  savesFts: number;
  likesFts: number;
  savesVec?: number;
  likesVec?: number;
}) {
  const prepare = vi.fn((sql: string) => ({
    get: () => {
      if (sql.includes("saved_items") && !sql.includes("fts") && !sql.includes("vec")) {
        return { c: opts.saves };
      }
      if (sql.includes("liked_items") && !sql.includes("fts") && !sql.includes("vec")) {
        return { c: opts.likes };
      }
      return { c: 0 };
    },
  }));
  vi.mocked(getSqlite).mockReturnValue({ prepare } as never);
  vi.mocked(ftsCount).mockImplementation((library) =>
    library === "saves" ? opts.savesFts : opts.likesFts,
  );
  vi.mocked(vecCount).mockImplementation((library) => {
    if (library === "saves") return opts.savesVec ?? opts.saves;
    return opts.likesVec ?? opts.likes;
  });
  vi.mocked(vectorIndexMatchesConfig).mockReturnValue(true);
}

describe("search readiness", () => {
  beforeEach(() => {
    resetSearchBackfillScheduleLatchForTests();
    vi.clearAllMocks();
    vi.mocked(hasOpenEmbeddingJobForTarget).mockReturnValue(false);
    vi.mocked(enqueueFtsBackfillJob).mockReturnValue({ id: 9 } as never);
    vi.mocked(startReindexJob).mockReturnValue({
      ok: true,
      job: { id: 1 },
      jobs: [],
    } as never);
  });

  afterEach(() => {
    resetSearchBackfillScheduleLatchForTests();
  });

  it("reports degraded when FTS lags item counts", () => {
    mockCounts({ saves: 10, likes: 5, savesFts: 3, likesFts: 5 });
    vi.mocked(isProviderConfigured).mockReturnValue(false);

    const gaps = assessSearchIndexGaps();
    expect(gaps.savesFtsGap).toBe(7);
    expect(gaps.likesFtsGap).toBe(0);
    expect(gaps.degraded).toBe(true);
  });

  it("enqueues fts and local jobs once when gaps exist", async () => {
    mockCounts({
      saves: 10,
      likes: 8,
      savesFts: 0,
      likesFts: 0,
      savesVec: 0,
      likesVec: 0,
    });
    vi.mocked(isProviderConfigured).mockImplementation(
      (provider, library) => provider === "local" && library === "saves",
    );
    vi.mocked(vectorIndexMatchesConfig).mockReturnValue(false);

    const first = await scheduleSearchBackfillJobsIfNeeded();
    expect(first.enqueued).toContain("fts");
    expect(first.enqueued).toContain("local");
    expect(enqueueFtsBackfillJob).toHaveBeenCalledTimes(1);
    expect(startReindexJob).toHaveBeenCalledWith("local");

    const second = await scheduleSearchBackfillJobsIfNeeded();
    expect(second.skipped).toBe(true);
    expect(enqueueFtsBackfillJob).toHaveBeenCalledTimes(1);
  });

  it("is not degraded when counts match and local is current", async () => {
    mockCounts({ saves: 4, likes: 2, savesFts: 4, likesFts: 2 });
    vi.mocked(isProviderConfigured).mockReturnValue(true);
    vi.mocked(vectorIndexMatchesConfig).mockReturnValue(true);

    const gaps = assessSearchIndexGaps();
    expect(gaps.degraded).toBe(false);
    expect((await scheduleSearchBackfillJobsIfNeeded()).enqueued).toEqual([]);
  });
});
