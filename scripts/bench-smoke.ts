/**
 * Light Gate A+ / R2 bench: synthetic parse / IN() chunk / zip-cap paths +
 * streaming-extract peak-RSS gate. Does NOT open the real library DB or call
 * Voyage/Ollama.
 *
 * Usage: pnpm bench:smoke
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
import {
  chunkIdsForSqlIn,
  SQL_IN_CLAUSE_BATCH_SIZE,
} from "../src/lib/search/sync-rows";
import { extractJsonFilesFromZip } from "../src/lib/import/zip-extract";
import { ImportZipSafetyError } from "../src/lib/import/types";

type BenchRow = { name: string; ms: number; detail: string };

/** Absolute peak RSS during streaming extract must stay under this (CI gate). */
export const ZIP_EXTRACT_PEAK_RSS_BUDGET_BYTES = 512 * 1024 * 1024;

/**
 * Delta above baseline RSS during extract — catches regressions that still
 * fit under the absolute ceiling on large CI runners.
 */
export const ZIP_EXTRACT_RSS_DELTA_BUDGET_BYTES = 96 * 1024 * 1024;

function msSince(start: number): number {
  return Math.round((performance.now() - start) * 10) / 10;
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function main() {
  const rows: BenchRow[] = [];

  // --- Parse (CPU only) ---
  const PARSE_N = 5_000;
  const savesJson = syntheticSavedPostsJson(PARSE_N, { prefix: "bench" });
  const likesJson = syntheticLikedPostsJson(PARSE_N, { prefix: "likebench" });

  let t0 = performance.now();
  const saves = parseExportJsonFiles([
    {
      name: "your_instagram_activity/saved/saved_posts.json",
      content: savesJson,
    },
  ]);
  rows.push({
    name: "parse_saves",
    ms: msSince(t0),
    detail: `${saves.items.length} items from ${PARSE_N} synthetic rows`,
  });

  t0 = performance.now();
  const likes = parseLikedExportJsonFiles([
    {
      name: "your_instagram_activity/likes/liked_posts.json",
      content: likesJson,
    },
  ]);
  rows.push({
    name: "parse_likes",
    ms: msSince(t0),
    detail: `${likes.items.length} items from ${PARSE_N} synthetic rows`,
  });

  // --- IN() chunking (no DB) ---
  const ID_N = 40_000;
  const ids = Array.from({ length: ID_N }, (_, i) => i + 1);
  t0 = performance.now();
  const batches = chunkIdsForSqlIn(ids);
  const chunkMs = msSince(t0);
  const expectedBatches = Math.ceil(ID_N / SQL_IN_CLAUSE_BATCH_SIZE);
  if (batches.length !== expectedBatches) {
    throw new Error(
      `chunkIdsForSqlIn: expected ${expectedBatches} batches, got ${batches.length}`,
    );
  }
  rows.push({
    name: "chunk_ids_in",
    ms: chunkMs,
    detail: `${ID_N} ids → ${batches.length} batches of ≤${SQL_IN_CLAUSE_BATCH_SIZE}`,
  });

  // --- Zip caps (temp file only; tiny limits) ---
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ig-bench-"));
  try {
    const okZipPath = path.join(tmpDir, "ok.zip");
    const bombZipPath = path.join(tmpDir, "bomb.zip");
    const rssZipPath = path.join(tmpDir, "rss.zip");
    const okZip = new AdmZip();
    okZip.addFile(
      "your_instagram_activity/saved/saved_posts.json",
      Buffer.from(syntheticSavedPostsJson(200, { prefix: "ok" }), "utf8"),
    );
    okZip.writeZip(okZipPath);

    const bombZip = new AdmZip();
    bombZip.addFile(
      "your_instagram_activity/saved/huge.json",
      Buffer.alloc(64 * 1024, 0x61), // 64 KiB
    );
    bombZip.writeZip(bombZipPath);

    // ~2–4 MiB JSON payload — large enough that a non-streaming load would
    // show up in the RSS delta budget, small enough for CI.
    const RSS_EXTRACT_N = 8_000;
    const rssZip = new AdmZip();
    rssZip.addFile(
      "your_instagram_activity/saved/saved_posts.json",
      Buffer.from(
        syntheticSavedPostsJson(RSS_EXTRACT_N, { prefix: "rss" }),
        "utf8",
      ),
    );
    rssZip.writeZip(rssZipPath);

    t0 = performance.now();
    const extracted = await extractJsonFilesFromZip(okZipPath, {
      zipSafetyLimits: {
        maxEntryUncompressedBytes: 8 * 1024 * 1024,
        maxTotalExtractedJsonBytes: 16 * 1024 * 1024,
      },
    });
    const extractedBytes = extracted.reduce((sum, f) => sum + f.byteSize, 0);
    rows.push({
      name: "zip_extract_ok",
      ms: msSince(t0),
      detail: `${extracted.length} json file(s), ${extractedBytes} bytes`,
    });

    t0 = performance.now();
    let rejected = false;
    try {
      await extractJsonFilesFromZip(bombZipPath, {
        zipSafetyLimits: {
          maxEntryUncompressedBytes: 1024, // 1 KiB — entry over cap
          maxTotalExtractedJsonBytes: 16 * 1024 * 1024,
        },
      });
    } catch (error) {
      if (error instanceof ImportZipSafetyError) rejected = true;
      else throw error;
    }
    if (!rejected) {
      throw new Error("zip_cap_reject: expected ImportZipSafetyError");
    }
    rows.push({
      name: "zip_cap_reject",
      ms: msSince(t0),
      detail: "ImportZipSafetyError on over-cap entry (fail-closed)",
    });

    // --- Peak RSS gate on streaming extract (R2 ci-rss) ---
    if (typeof global.gc === "function") {
      global.gc();
    }
    const baselineRss = process.memoryUsage().rss;
    let peakRss = baselineRss;
    const sample = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 5);
    t0 = performance.now();
    try {
      await extractJsonFilesFromZip(rssZipPath, {
        zipSafetyLimits: {
          maxEntryUncompressedBytes: 32 * 1024 * 1024,
          maxTotalExtractedJsonBytes: 64 * 1024 * 1024,
        },
      });
    } finally {
      clearInterval(sample);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    const rssMs = msSince(t0);
    const delta = Math.max(0, peakRss - baselineRss);
    rows.push({
      name: "zip_extract_rss",
      ms: rssMs,
      detail: `peak ${formatMiB(peakRss)} (Δ ${formatMiB(delta)}; budget Δ ${formatMiB(ZIP_EXTRACT_RSS_DELTA_BUDGET_BYTES)}, peak ${formatMiB(ZIP_EXTRACT_PEAK_RSS_BUDGET_BYTES)})`,
    });
    if (peakRss > ZIP_EXTRACT_PEAK_RSS_BUDGET_BYTES) {
      throw new Error(
        `zip_extract_rss: peak RSS ${formatMiB(peakRss)} exceeds absolute budget ${formatMiB(ZIP_EXTRACT_PEAK_RSS_BUDGET_BYTES)}`,
      );
    }
    if (delta > ZIP_EXTRACT_RSS_DELTA_BUDGET_BYTES) {
      throw new Error(
        `zip_extract_rss: RSS delta ${formatMiB(delta)} exceeds budget ${formatMiB(ZIP_EXTRACT_RSS_DELTA_BUDGET_BYTES)} (streaming-extract regression?)`,
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("[bench-smoke] synthetic timings (no real DB / no remote embeds)");
  for (const row of rows) {
    console.log(
      `[bench-smoke] ${row.name.padEnd(16)} ${String(row.ms).padStart(8)} ms  ${row.detail}`,
    );
  }
}

main().catch((error) => {
  console.error("[bench-smoke] failed", error);
  process.exit(1);
});
