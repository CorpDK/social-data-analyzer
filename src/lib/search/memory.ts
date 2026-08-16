import fs from "node:fs";
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from "./embeddings";
import type { SearchLibrary } from "./library";

/** Libraries at or above this size get stronger reindex warnings / RAM gates. */
export const LARGE_LIBRARY_ITEM_THRESHOLD = 20_000;

/**
 * Refuse any provider reindex when MemAvailable is below this (critically low
 * headroom for Node + SQLite + API/model client). Shared floor for all
 * providers — not an OS cgroup guarantee.
 */
export const CRITICAL_MIN_AVAILABLE_MB = 512;

/** @deprecated Prefer CRITICAL_MIN_AVAILABLE_MB (same value; kept for status clients). */
export const OLLAMA_CRITICAL_MIN_AVAILABLE_MB = CRITICAL_MIN_AVAILABLE_MB;

/**
 * Refuse large Ollama rebuilds when MemAvailable is below this (GiB-scale
 * headroom for local model + Node chunk + SQLite). Tuned for
 * qwen3-embedding-class models on a personal machine.
 */
export const OLLAMA_LARGE_MIN_AVAILABLE_MB = 1_536;

/**
 * Refuse large Voyage/OpenAI/local rebuilds when MemAvailable is below this.
 * Lower than Ollama because the embedding model is remote (or a tiny local
 * hasher), but still real headroom for Node heap + SQLite vec writes.
 */
export const REMOTE_LARGE_MIN_AVAILABLE_MB = 1_024;

/** Soft UI warning when estimated raw vector payload exceeds this. */
export const HIGH_VECTOR_MB_WARNING = 256;

/** Default Node --max-old-space-size for the embedding worker (MB). */
export const EMBEDDING_WORKER_DEFAULT_MAX_OLD_SPACE_MB = 2_048;

export function estimatedVectorMegabytes(
  itemCount: number,
  dimensions = EMBEDDING_DIMENSIONS,
): number {
  return (itemCount * dimensions * 4) / (1024 * 1024);
}

/** Linux MemAvailable from /proc/meminfo; null on non-Linux or parse failure. */
export function readMemAvailableMb(): number | null {
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
    const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (!match) return null;
    return Number(match[1]) / 1024;
  } catch {
    return null;
  }
}

export type ReindexMemoryAssessment = {
  library: SearchLibrary;
  provider: EmbeddingProvider;
  totalItems: number;
  estimatedVectorMb: number;
  memAvailableMb: number | null;
  isLargeLibrary: boolean;
  /** Soft warning for UI confirm (Voyage/OpenAI/local/Ollama). */
  warning: string | null;
  /** Stronger copy for large/low-RAM cases. */
  strongWarning: string | null;
  /** Hard server-side refuse (any provider when RAM is too low). */
  refuse: boolean;
  refuseReason: string | null;
};

function isLargeLibrary(library: SearchLibrary, totalItems: number): boolean {
  if (totalItems >= LARGE_LIBRARY_ITEM_THRESHOLD) return true;
  // Likes libraries are often huge; treat mid-size likes as large for
  // warnings / RAM gates without spamming empty or tiny test DBs.
  if (library === "likes" && totalItems >= 5_000) return true;
  return false;
}

function providerLabel(provider: EmbeddingProvider): string {
  switch (provider) {
    case "local":
      return "local";
    case "ollama":
      return "Ollama";
    case "voyage":
      return "Voyage";
    case "openai":
      return "OpenAI";
  }
}

/** Large-library MemAvailable floor for this provider. */
export function largeLibraryMinAvailableMb(
  provider: EmbeddingProvider,
): number {
  return provider === "ollama"
    ? OLLAMA_LARGE_MIN_AVAILABLE_MB
    : REMOTE_LARGE_MIN_AVAILABLE_MB;
}

/**
 * Assess RAM / size risk for a concrete library+provider reindex.
 * Soft warnings for all providers; hard refuse when free RAM is critically
 * low (any size) or below the provider's large-library floor.
 */
export function assessReindexMemory(
  library: SearchLibrary,
  provider: EmbeddingProvider,
  totalItems: number,
  memAvailableMb: number | null = readMemAvailableMb(),
): ReindexMemoryAssessment {
  const estimatedVectorMb = estimatedVectorMegabytes(totalItems);
  const large = isLargeLibrary(library, totalItems);
  const avail = memAvailableMb;
  const label = providerLabel(provider);
  const largeMin = largeLibraryMinAvailableMb(provider);

  let warning: string | null = null;
  let strongWarning: string | null = null;
  let refuse = false;
  let refuseReason: string | null = null;

  if (totalItems <= 0) {
    return {
      library,
      provider,
      totalItems,
      estimatedVectorMb,
      memAvailableMb: avail,
      isLargeLibrary: large,
      warning: null,
      strongWarning: null,
      refuse: false,
      refuseReason: null,
    };
  }

  const sizeBits: string[] = [];
  if (library === "likes") sizeBits.push("likes library");
  if (totalItems >= LARGE_LIBRARY_ITEM_THRESHOLD) {
    sizeBits.push(`${totalItems.toLocaleString()} items`);
  }
  if (estimatedVectorMb >= HIGH_VECTOR_MB_WARNING) {
    sizeBits.push(`~${estimatedVectorMb.toFixed(0)} MB raw vectors @ ${EMBEDDING_DIMENSIONS}-d`);
  }

  if (avail != null && avail < CRITICAL_MIN_AVAILABLE_MB) {
    refuse = true;
    refuseReason =
      `${label} reindex refused: only ~${avail.toFixed(0)} MB RAM available ` +
      `(need at least ${CRITICAL_MIN_AVAILABLE_MB} MB free). Free memory and try again.`;
    strongWarning = refuseReason;
  } else if (large && avail != null && avail < largeMin) {
    refuse = true;
    refuseReason =
      `${label} reindex of this ${library} library (${totalItems.toLocaleString()} items, ` +
      `~${estimatedVectorMb.toFixed(0)} MB vectors) refused: MemAvailable ~${avail.toFixed(0)} MB ` +
      `(need ≥${largeMin} MB). Free RAM` +
      (provider === "ollama" ? " or use Voyage/OpenAI if host RAM is still tight." : " and try again.");
    strongWarning = refuseReason;
  } else if (provider === "ollama" && large) {
    strongWarning =
      `Large ${library} Ollama reindex (${totalItems.toLocaleString()} items` +
      (estimatedVectorMb >= 1
        ? `, ~${estimatedVectorMb.toFixed(0)} MB vectors`
        : "") +
      "). Ollama keeps the model in RAM alongside Node and SQLite — " +
      (avail != null ? `MemAvailable ~${avail.toFixed(0)} MB. ` : "") +
      "Prefer Voyage/OpenAI if the machine feels tight.";
    warning = strongWarning;
  } else if (provider === "ollama" && avail != null && avail < OLLAMA_LARGE_MIN_AVAILABLE_MB) {
    warning =
      `MemAvailable ~${avail.toFixed(0)} MB is tight for Ollama. ` +
      "A smaller saves reindex can still run; free RAM if the UI feels sluggish.";
  } else if (large || estimatedVectorMb >= HIGH_VECTOR_MB_WARNING) {
    warning =
      `Large ${library} ${label} reindex` +
      (sizeBits.length > 0 ? ` (${sizeBits.join("; ")})` : "") +
      (avail != null ? `. MemAvailable ~${avail.toFixed(0)} MB` : "") +
      ". This can take a while and use substantial disk/RAM; you can cancel the active job if needed.";
    if (
      avail != null &&
      avail < largeMin + 512
    ) {
      strongWarning = warning;
    }
  } else if (
    avail != null &&
    avail < REMOTE_LARGE_MIN_AVAILABLE_MB &&
    provider !== "ollama"
  ) {
    warning =
      `MemAvailable ~${avail.toFixed(0)} MB is tight for reindex. ` +
      "A smaller library can still run; free RAM if the machine feels sluggish.";
  }

  return {
    library,
    provider,
    totalItems,
    estimatedVectorMb,
    memAvailableMb: avail,
    isLargeLibrary: large,
    warning,
    strongWarning,
    refuse,
    refuseReason,
  };
}

/** Soft console signal (in addition to UI / hard refuse). */
export function logReindexMemoryWarning(assessment: ReindexMemoryAssessment) {
  if (assessment.refuse && assessment.refuseReason) {
    console.warn(`[search] ${assessment.refuseReason}`);
    return;
  }
  const msg = assessment.strongWarning ?? assessment.warning;
  if (msg) console.warn(`[search] ${msg}`);
}

/**
 * Resolve embedding-worker heap cap (MB). Override with
 * EMBEDDING_WORKER_MAX_OLD_SPACE_MB; default 2048.
 */
export function resolveEmbeddingWorkerMaxOldSpaceMb(): number {
  const raw = process.env.EMBEDDING_WORKER_MAX_OLD_SPACE_MB?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 256 && parsed <= 16_384) {
      return Math.floor(parsed);
    }
  }
  return EMBEDDING_WORKER_DEFAULT_MAX_OLD_SPACE_MB;
}

/**
 * Merge `--max-old-space-size=N` into NODE_OPTIONS without clobbering unrelated
 * flags. The requested heap cap is authoritative: any inherited
 * `--max-old-space-size` (e.g. Next's large parent heap) is replaced so the
 * embedding worker stays at EMBEDDING_WORKER_MAX_OLD_SPACE_MB / default 2048.
 */
export function mergeNodeOptionsMaxOldSpace(
  existing: string | undefined,
  maxOldSpaceMb: number = resolveEmbeddingWorkerMaxOldSpaceMb(),
): string {
  const flag = `--max-old-space-size=${maxOldSpaceMb}`;
  const trimmed = existing?.trim() ?? "";
  if (!trimmed) return flag;
  const withoutHeap = trimmed
    .replace(/(?:^|\s)--max-old-space-size=\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return withoutHeap ? `${withoutHeap} ${flag}` : flag;
}
