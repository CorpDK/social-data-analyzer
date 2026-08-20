import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const assess = vi.fn();
vi.mock("../storage", () => ({
  getStorage: vi.fn(async () => ({
    search: { assessSearchIndexGaps: assess },
  })),
}));

vi.mock("./jobs", () => ({
  ensureJobRunner: vi.fn(),
  enqueueFtsBackfillJob: vi.fn(),
  hasOpenEmbeddingJobForTarget: vi.fn(async () => false),
  startReindexJob: vi.fn(async () => ({ ok: true, job: { id: 1 }, jobs: [] })),
}));

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
  const savesFtsGap = Math.max(0, opts.saves - opts.savesFts);
  const likesFtsGap = Math.max(0, opts.likes - opts.likesFts);
  const savesLocalGap = (opts.savesVec ?? opts.saves) < opts.saves;
  const likesLocalGap = (opts.likesVec ?? opts.likes) < opts.likes;
  assess.mockResolvedValue({
    savesItems: opts.saves,
    likesItems: opts.likes,
    savesFtsGap,
    likesFtsGap,
    savesLocalGap,
    likesLocalGap,
    degraded:
      savesFtsGap > 0 || likesFtsGap > 0 || savesLocalGap || likesLocalGap,
  });
}

describe("search readiness", () => {
  beforeEach(() => {
    resetSearchBackfillScheduleLatchForTests();
    vi.clearAllMocks();
    vi.mocked(hasOpenEmbeddingJobForTarget).mockResolvedValue(false);
    vi.mocked(enqueueFtsBackfillJob).mockResolvedValue({ id: 9 } as never);
    vi.mocked(startReindexJob).mockResolvedValue({
      ok: true,
      job: { id: 1 },
      jobs: [],
    } as never);
  });

  afterEach(() => {
    resetSearchBackfillScheduleLatchForTests();
  });

  it("reports degraded when FTS lags item counts", async () => {
    mockCounts({ saves: 10, likes: 5, savesFts: 3, likesFts: 5 });
    const gaps = await assessSearchIndexGaps();
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
    const gaps = await assessSearchIndexGaps();
    expect(gaps.degraded).toBe(false);
    expect((await scheduleSearchBackfillJobsIfNeeded()).enqueued).toEqual([]);
  });
});
