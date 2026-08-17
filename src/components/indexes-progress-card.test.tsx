import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EmbeddingJobDto } from "@/lib/search/status-dto";
import { JobSummaryRow, jobStateStyles } from "./indexes-progress-card";

function makeJob(
  overrides: Partial<EmbeddingJobDto> = {},
): EmbeddingJobDto {
  return {
    id: 1,
    target: "saves:local",
    state: "completed",
    phase: "done",
    processed: 10,
    total: 10,
    percent: 100,
    currentProvider: "local",
    error: null,
    message: null,
    cancelRequested: false,
    startedAt: 1,
    finishedAt: 2,
    updatedAt: 2,
    ...overrides,
  };
}

describe("jobStateStyles", () => {
  it("maps job states to distinct class tokens", () => {
    expect(jobStateStyles("running")).toContain("accent");
    expect(jobStateStyles("failed")).toContain("danger");
    expect(jobStateStyles("pending")).toContain("muted");
  });
});

describe("JobSummaryRow", () => {
  it("renders state, target, phase, and item counts for finished jobs", () => {
    render(<JobSummaryRow job={makeJob()} />);

    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByText("saves:local")).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.getByText(/10\/10 items/)).toBeInTheDocument();
  });

  it("hides item counts while pending or running", () => {
    const { container, rerender } = render(
      <JobSummaryRow job={makeJob({ state: "running", phase: "embedding" })} />,
    );
    expect(container.textContent).not.toMatch(/\d+\/\d+ items/);

    rerender(
      <JobSummaryRow job={makeJob({ state: "pending", phase: "queued" })} />,
    );
    expect(container.textContent).not.toMatch(/\d+\/\d+ items/);
  });
});
