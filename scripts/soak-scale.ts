/**
 * Synthetic library soak harness (R3 soak-250k).
 *
 * Default mode is a fast smoke (1k likes) that imports into a temp DB, rebuilds
 * FTS keyword indexes (no Voyage/Ollama), and asserts integrity_check.
 *
 * Full 250k soak (manual / release note; can take many minutes):
 *
 *   SOAK_N=250000 pnpm soak:scale
 *
 * Does NOT touch the real library DB.
 *
 * Usage: pnpm soak:scale
 */
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Full Beyond A+ soak target. */
export const SOAK_FULL_N = 250_000;

/** Default automated smoke. */
export const SOAK_SMOKE_N = 1_000;

/** Soft wall-time budgets for smoke only (hard-fail). */
export const SMOKE_IMPORT_BUDGET_MS = 15_000;
export const SMOKE_FTS_BUDGET_MS = 10_000;

function resolveN(): { n: number; mode: "smoke" | "full" | "custom" } {
  const raw = process.env.SOAK_N?.trim();
  if (!raw) {
    return { n: SOAK_SMOKE_N, mode: "smoke" };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`SOAK_N must be a positive integer, got ${raw}`);
  }
  if (n === SOAK_FULL_N) return { n, mode: "full" };
  if (n === SOAK_SMOKE_N) return { n, mode: "smoke" };
  return { n, mode: "custom" };
}

function msSince(start: number): number {
  return Math.round((performance.now() - start) * 10) / 10;
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function main() {
  const { n, mode } = resolveN();
  const hardFailWall =
    mode === "smoke" || process.env.SOAK_HARD_FAIL === "1";

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ig-soak-"));
  const tmpDb = path.join(tmpDir, "soak.db");

  // Must set before importing db / import modules (singleton connection).
  process.env.INSTAGRAM_SAVES_DB = tmpDb;
  process.env.INSTAGRAM_SAVES_KEYRING = "memory";
  process.env.EMBEDDING_WORKER_INLINE = "1";
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.VOYAGE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OLLAMA_BASE_URL;

  console.log(
    `[soak-scale] mode=${mode} N=${n} db=${tmpDb} (set SOAK_N=${SOAK_FULL_N} for full soak)`,
  );

  const { syntheticLikedPostsJson } = await import(
    "../src/lib/parse/synthetic"
  );
  const { importExportJson } = await import("../src/lib/import-export");
  const { closeStorage, getStorage, getSqlite } = await import(
    "../src/lib/storage"
  );
  const { checkSqliteIntegrity } = await import("../src/lib/db/integrity");
  const { rebuildKeywordIndexes, ftsCount } = await import(
    "../src/lib/search/sync"
  );

  const likesJson = syntheticLikedPostsJson(n, { prefix: "Sk" });
  const jsonBytes = Buffer.byteLength(likesJson, "utf8");

  if (typeof global.gc === "function") {
    global.gc();
  }
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  const sample = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 25);

  let importMs = 0;
  let ftsMs = 0;
  let likesAdded = 0;

  try {
    let t0 = performance.now();
    const result = await importExportJson(
      likesJson,
      "your_instagram_activity/likes/liked_posts.json",
    );
    importMs = msSince(t0);
    likesAdded = result.likesAdded;

    if (result.status !== "completed") {
      throw new Error(
        `import status=${result.status}: ${result.message}`,
      );
    }
    if (result.likesFound !== n || result.likesAdded !== n) {
      throw new Error(
        `import counts: found=${result.likesFound} added=${result.likesAdded} expected=${n}`,
      );
    }
    if (hardFailWall && importMs > SMOKE_IMPORT_BUDGET_MS) {
      throw new Error(
        `import: ${importMs} ms exceeds smoke budget ${SMOKE_IMPORT_BUDGET_MS} ms`,
      );
    }

    t0 = performance.now();
    const fts = await rebuildKeywordIndexes();
    ftsMs = msSince(t0);

    await getStorage();
    const sqlite = getSqlite();
    const likedRows = (
      sqlite.prepare(`SELECT COUNT(*) AS c FROM liked_items`).get() as {
        c: number;
      }
    ).c;
    const likedFts = ftsCount("likes", sqlite);

    if (likedRows !== n) {
      throw new Error(`liked_items count=${likedRows}, expected ${n}`);
    }
    if (likedFts !== n) {
      throw new Error(
        `liked_items_fts count=${likedFts}, expected ${n} (rebuilt=${fts.rebuilt})`,
      );
    }
    if (hardFailWall && ftsMs > SMOKE_FTS_BUDGET_MS) {
      throw new Error(
        `fts: ${ftsMs} ms exceeds smoke budget ${SMOKE_FTS_BUDGET_MS} ms`,
      );
    }

    const integrity = checkSqliteIntegrity(sqlite);
    if (!integrity.ok) {
      throw new Error(`integrity_check failed: ${integrity.detail}`);
    }
  } finally {
    clearInterval(sample);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    closeStorage();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const delta = Math.max(0, peakRss - baselineRss);
  const summary = {
    mode,
    n,
    jsonMiB: Math.round((jsonBytes / (1024 * 1024)) * 100) / 100,
    importMs,
    ftsMs,
    likesAdded,
    peakRssMiB: Math.round((peakRss / (1024 * 1024)) * 10) / 10,
    deltaRssMiB: Math.round((delta / (1024 * 1024)) * 10) / 10,
    integrity: "ok",
  };

  console.log(
    `[soak-scale] import ${importMs} ms · fts ${ftsMs} ms · likes=${likesAdded} · peak ${formatMiB(peakRss)} (Δ ${formatMiB(delta)}) · integrity ok`,
  );
  console.log(`[soak-scale] json ${JSON.stringify(summary)}`);
}

main().catch((error) => {
  console.error("[soak-scale] failed", error);
  process.exit(1);
});
