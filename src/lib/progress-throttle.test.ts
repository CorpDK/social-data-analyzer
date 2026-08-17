import { describe, expect, it } from "vitest";
import {
  createProgressThrottleState,
  markProgressPublished,
  shouldPublishProgress,
} from "./progress-throttle";

describe("shouldPublishProgress", () => {
  it("publishes on force and listed force phases", () => {
    const state = createProgressThrottleState();
    expect(
      shouldPublishProgress(
        { phase: "embedding", processed: 1, total: 100 },
        state,
        { force: true },
      ),
    ).toBe(true);
    expect(
      shouldPublishProgress(
        { phase: "preparing", processed: 1, total: 100 },
        state,
        { forcePhases: ["preparing"] },
      ),
    ).toBe(true);
  });

  it("publishes every N items or when minMs elapses", () => {
    const state = markProgressPublished(
      createProgressThrottleState(),
      { phase: "embedding", processed: 0, total: 200 },
      1_000,
    );

    expect(
      shouldPublishProgress(
        { phase: "embedding", processed: 10, total: 200 },
        state,
        { everyN: 50, minMs: 1_000, now: 1_500 },
      ),
    ).toBe(false);

    expect(
      shouldPublishProgress(
        { phase: "embedding", processed: 50, total: 200 },
        state,
        { everyN: 50, minMs: 1_000, now: 1_500 },
      ),
    ).toBe(true);

    expect(
      shouldPublishProgress(
        { phase: "embedding", processed: 10, total: 200 },
        state,
        { everyN: 50, minMs: 1_000, now: 2_000 },
      ),
    ).toBe(true);
  });

  it("publishes on phase change and completion", () => {
    const state = markProgressPublished(
      createProgressThrottleState(),
      { phase: "fts", processed: 5, total: 100 },
      1_000,
    );

    expect(
      shouldPublishProgress(
        { phase: "embedding", processed: 6, total: 100 },
        state,
        { now: 1_100 },
      ),
    ).toBe(true);

    expect(
      shouldPublishProgress(
        { phase: "fts", processed: 100, total: 100 },
        state,
        { now: 1_100 },
      ),
    ).toBe(true);
  });
});
