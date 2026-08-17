/**
 * Light Gate A+ bench: synthetic parse / IN() chunk / zip-cap paths.
 * Does NOT open the real library DB or call Voyage/Ollama.
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
  chunkIdsForSqlIn,
  SQL_IN_CLAUSE_BATCH_SIZE,
} from "../src/lib/search/sync-rows";
import { extractJsonFilesFromZip } from "../src/lib/import/zip-extract";
import { ImportZipSafetyError } from "../src/lib/import/types";

type BenchRow = { name: string; ms: number; detail: string };

function msSince(start: number): number {
  return Math.round((performance.now() - start) * 10) / 10;
}

function syntheticSavedPostsJson(count: number): string {
  const items = Array.from({ length: count }, (_, i) => ({
    title: `user${i % 50}`,
    string_list_data: [
      {
        href: `https://www.instagram.com/reel/bench${i}/`,
        timestamp: 1_700_000_000 + i,
        value: `user${i % 50}`,
      },
    ],
  }));
  return JSON.stringify({ saved_saved_media: items });
}

function syntheticLikedPostsJson(count: number): string {
  const items = Array.from({ length: count }, (_, i) => ({
    title: `liker${i % 40}`,
    string_list_data: [
      {
        href: `https://www.instagram.com/p/likebench${i}/`,
        timestamp: 1_700_100_000 + i,
      },
    ],
  }));
  return JSON.stringify({ likes_media_likes: items });
}

async function main() {
  const rows: BenchRow[] = [];

  // --- Parse (CPU only) ---
  const PARSE_N = 5_000;
  const savesJson = syntheticSavedPostsJson(PARSE_N);
  const likesJson = syntheticLikedPostsJson(PARSE_N);

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
    const okZip = new AdmZip();
    okZip.addFile(
      "your_instagram_activity/saved/saved_posts.json",
      Buffer.from(syntheticSavedPostsJson(200), "utf8"),
    );
    okZip.writeZip(okZipPath);

    const bombZip = new AdmZip();
    bombZip.addFile(
      "your_instagram_activity/saved/huge.json",
      Buffer.alloc(64 * 1024, 0x61), // 64 KiB
    );
    bombZip.writeZip(bombZipPath);

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
