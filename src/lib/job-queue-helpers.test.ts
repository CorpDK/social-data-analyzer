import { describe, expect, it } from "vitest";
import {
  createJobSqlSet,
  jobProgressPercent,
  setJobColumn,
  setJobFinishedAt,
} from "./job-queue";

describe("jobProgressPercent", () => {
  it("reports 0 for incomplete jobs with unknown total", () => {
    expect(jobProgressPercent(0, 0, false)).toBe(0);
    expect(jobProgressPercent(5, 0, false)).toBe(0);
  });

  it("reports 100 for completed jobs with unknown total", () => {
    expect(jobProgressPercent(0, 0, true)).toBe(100);
  });

  it("rounds to one decimal", () => {
    expect(jobProgressPercent(1, 3, false)).toBe(33.3);
    expect(jobProgressPercent(2, 3, false)).toBe(66.7);
    expect(jobProgressPercent(3, 3, false)).toBe(100);
  });
});

describe("JobSqlSet helpers", () => {
  it("builds updated_at plus optional columns", () => {
    const sql = createJobSqlSet();
    setJobColumn(sql, "state", "running");
    setJobColumn(sql, "message", null);
    setJobColumn(sql, "processed", undefined);
    setJobFinishedAt(sql);
    expect(sql.sets[0]).toBe("updated_at = unixepoch()");
    expect(sql.sets).toContain("state = ?");
    expect(sql.sets).toContain("message = ?");
    expect(sql.sets).toContain("finished_at = unixepoch()");
    expect(sql.sets.some((s) => s.startsWith("processed"))).toBe(false);
    expect(sql.values).toEqual(["running", null]);
  });
});
