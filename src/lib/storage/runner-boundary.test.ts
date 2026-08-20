import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const RUNNER_FILES = [
  "src/lib/import/jobs.ts",
  "src/lib/import/run-pipeline.ts",
  "src/lib/import/run-helpers.ts",
  "src/lib/search/embeddings.ts",
  "src/lib/search/hybrid.ts",
  "src/lib/search/jobs.ts",
  "src/lib/search/providers.ts",
  "src/lib/search/readiness.ts",
  "src/lib/search/status.ts",
  "src/lib/search/sync.ts",
  "src/lib/search/sync-embed.ts",
  "scripts/embedding-worker.ts",
  "scripts/reindex-search.ts",
];

describe("multi-engine runner boundary", () => {
  it.each(RUNNER_FILES)("%s does not bypass storage ports", (relativePath) => {
    const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
    expect(source).not.toMatch(/\bgetSqlite\s*\(/);
    expect(source).not.toMatch(/\bgetDb\s*\(/);
    expect(source).not.toMatch(/from\s+["'][^"']*\/db["']/);
    expect(source).not.toContain("better-sqlite3");
  });
});
