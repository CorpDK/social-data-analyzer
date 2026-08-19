/**
 * Scale RSS / wall-time baseline harness (R3 rss-50k).
 *
 * Default mode is a fast smoke (2k rows) suitable for CI / local verification.
 * Full Gate B+ soft baseline:
 *
 *   BENCH_SCALE_N=50000 pnpm bench:scale
 *
 * Does NOT open the real library DB or call Voyage/Ollama.
 *
 * Usage: pnpm bench:scale
 */
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { parseExportJsonFiles } from "../src/lib/parse/saves";
import { parseLikedExportJsonFiles } from "../src/lib/parse/likes";
import {
  syntheticLikedPostsJson,
  syntheticSavedPostsJson,
} from "../src/lib/parse/synthetic";
import { extractJsonFilesFromZip } from "../src/lib/import/zip-extract";

type BenchRow = {
  name: string;
  ms: number;
  detail: string;
  peakRssMiB?: number;
  deltaRssMiB?: number;
};

/** Full baseline target from Beyond A+ / remaining-work R3. */
export const BENCH_SCALE_FULL_N = 50_000;

/** Default automated smoke — proves the harness without multi-minute runs. */
export const BENCH_SCALE_SMOKE_N = 2_000;

/**
 * Soft wall-time budgets (ms) for smoke N only — hard-fail in smoke mode so CI
 * catches gross regressions. Full 50k runs record numbers without failing on
 * wall-time (machine variance); RSS absolute ceiling still applies.
 */
export const SMOKE_PARSE_SAVES_BUDGET_MS = 2_500;
export const SMOKE_PARSE_LIKES_BUDGET_MS = 2_500;
export const SMOKE_ZIP_EXTRACT_BUDGET_MS = 5_000;

/** Absolute peak RSS ceiling during 50k-path extract (same order as smoke gate). */
export const SCALE_PEAK_RSS_BUDGET_BYTES = 768 * 1024 * 1024;

/** RSS delta above baseline during extract+parse at scale. */
export const SCALE_RSS_DELTA_BUDGET_BYTES = 256 * 1024 * 1024;

function resolveN(): { n: number; mode: "smoke" | "full" | "custom" } {
  const raw = process.env.BENCH_SCALE_N?.trim();
  if (!raw) {
    return { n: BENCH_SCALE_SMOKE_N, mode: "smoke" };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`BENCH_SCALE_N must be a positive integer, got ${raw}`);
  }
  if (n === BENCH_SCALE_FULL_N) return { n, mode: "full" };
  if (n === BENCH_SCALE_SMOKE_N) return { n, mode: "smoke" };
  return { n, mode: "custom" };
}

function msSince(start: number): number {
  return Math.round((performance.now() - start) * 10) / 10;
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function sampleRss(onSample: (rss: number) => void): () => void {
  const id = setInterval(() => onSample(process.memoryUsage().rss), 10);
  return () => clearInterval(id);
}

async function main() {
  const { n, mode } = resolveN();
  const rows: BenchRow[] = [];
  const hardFailWall =
    mode === "smoke" || process.env.BENCH_SCALE_HARD_FAIL === "1";

  console.log(
    `[bench-scale] mode=${mode} N=${n} (set BENCH_SCALE_N=${BENCH_SCALE_FULL_N} for full baseline)`,
  );

  if (typeof global.gc === "function") {
    global.gc();
  }

  // --- Parse saves ---
  const savesJson = syntheticSavedPostsJson(n, { prefix: "ScS" });
  let t0 = performance.now();
  const saves = parseExportJsonFiles([
    {
      name: "your_instagram_activity/saved/saved_posts.json",
      content: savesJson,
    },
  ]);
  const savesMs = msSince(t0);
  rows.push({
    name: "parse_saves",
    ms: savesMs,
    detail: `${saves.items.length}/${n} items`,
  });
  if (saves.items.length !== n) {
    throw new Error(
      `parse_saves: expected ${n} items, got ${saves.items.length}`,
    );
  }
  if (hardFailWall && savesMs > SMOKE_PARSE_SAVES_BUDGET_MS) {
    throw new Error(
      `parse_saves: ${savesMs} ms exceeds smoke budget ${SMOKE_PARSE_SAVES_BUDGET_MS} ms`,
    );
  }

  // --- Parse likes ---
  const likesJson = syntheticLikedPostsJson(n, { prefix: "ScL" });
  t0 = performance.now();
  const likes = parseLikedExportJsonFiles([
    {
      name: "your_instagram_activity/likes/liked_posts.json",
      content: likesJson,
    },
  ]);
  const likesMs = msSince(t0);
  rows.push({
    name: "parse_likes",
    ms: likesMs,
    detail: `${likes.items.length}/${n} items`,
  });
  if (likes.items.length !== n) {
    throw new Error(
      `parse_likes: expected ${n} items, got ${likes.items.length}`,
    );
  }
  if (hardFailWall && likesMs > SMOKE_PARSE_LIKES_BUDGET_MS) {
    throw new Error(
      `parse_likes: ${likesMs} ms exceeds smoke budget ${SMOKE_PARSE_LIKES_BUDGET_MS} ms`,
    );
  }

  // --- Zip extract + streaming parse path (RSS) ---
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ig-bench-scale-"));
  try {
    const zipPath = path.join(tmpDir, "scale.zip");
    const zip = new AdmZip();
    zip.addFile(
      "your_instagram_activity/saved/saved_posts.json",
      Buffer.from(savesJson, "utf8"),
    );
    zip.writeZip(zipPath);

    if (typeof global.gc === "function") {
      global.gc();
    }
    const baselineRss = process.memoryUsage().rss;
    let peakRss = baselineRss;
    const stop = sampleRss((rss) => {
      peakRss = Math.max(peakRss, rss);
    });

    t0 = performance.now();
    try {
      const extracted = await extractJsonFilesFromZip(zipPath, {
        zipSafetyLimits: {
          maxEntryUncompressedBytes: 256 * 1024 * 1024,
          maxTotalExtractedJsonBytes: 512 * 1024 * 1024,
        },
      });
      // Parse extracted content (simulates import parse-after-extract).
      const reparsed = parseExportJsonFiles(
        extracted.map((f) => ({ name: f.name, content: f.content })),
      );
      if (reparsed.items.length !== n) {
        throw new Error(
          `zip_extract_parse: expected ${n} items, got ${reparsed.items.length}`,
        );
      }
    } finally {
      stop();
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    const extractMs = msSince(t0);
    const delta = Math.max(0, peakRss - baselineRss);
    rows.push({
      name: "zip_extract_parse",
      ms: extractMs,
      detail: `peak ${formatMiB(peakRss)} (Δ ${formatMiB(delta)})`,
      peakRssMiB: Math.round((peakRss / (1024 * 1024)) * 10) / 10,
      deltaRssMiB: Math.round((delta / (1024 * 1024)) * 10) / 10,
    });

    if (hardFailWall && extractMs > SMOKE_ZIP_EXTRACT_BUDGET_MS) {
      throw new Error(
        `zip_extract_parse: ${extractMs} ms exceeds smoke budget ${SMOKE_ZIP_EXTRACT_BUDGET_MS} ms`,
      );
    }
    if (peakRss > SCALE_PEAK_RSS_BUDGET_BYTES) {
      throw new Error(
        `zip_extract_parse: peak RSS ${formatMiB(peakRss)} exceeds budget ${formatMiB(SCALE_PEAK_RSS_BUDGET_BYTES)}`,
      );
    }
    if (delta > SCALE_RSS_DELTA_BUDGET_BYTES) {
      throw new Error(
        `zip_extract_parse: RSS Δ ${formatMiB(delta)} exceeds budget ${formatMiB(SCALE_RSS_DELTA_BUDGET_BYTES)}`,
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(
    `[bench-scale] results (no real DB / no remote embeds) mode=${mode} N=${n}`,
  );
  for (const row of rows) {
    console.log(
      `[bench-scale] ${row.name.padEnd(18)} ${String(row.ms).padStart(8)} ms  ${row.detail}`,
    );
  }

  // Machine-readable line for release notes / contracts paste.
  const summary = {
    mode,
    n,
    rows: rows.map((r) => ({
      name: r.name,
      ms: r.ms,
      peakRssMiB: r.peakRssMiB,
      deltaRssMiB: r.deltaRssMiB,
    })),
  };
  console.log(`[bench-scale] json ${JSON.stringify(summary)}`);
}

main().catch((error) => {
  console.error("[bench-scale] failed", error);
  process.exit(1);
});
