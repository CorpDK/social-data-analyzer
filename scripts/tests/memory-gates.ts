import type { TestContext } from "./harness";

/** RAM refuse gates + NODE_OPTIONS heap merge (no live reindex). */
export async function runMemoryGatesSuite(_ctx: TestContext) {
  console.log("[suite] memory-gates");

  // --- Resume + RAM gate helpers (no real Ollama / large DB work) ---
  const {
    assessReindexMemory,
    CRITICAL_MIN_AVAILABLE_MB,
    OLLAMA_LARGE_MIN_AVAILABLE_MB,
    REMOTE_LARGE_MIN_AVAILABLE_MB,
    mergeNodeOptionsMaxOldSpace,
  } = await import("../../src/lib/search/memory");
  const { getSearchIndexStatus } = await import("../../src/lib/search/status");

  const refuseLarge = assessReindexMemory("likes", "ollama", 25_000, 800);
  if (!refuseLarge.refuse || !refuseLarge.refuseReason) {
    throw new Error("Ollama likes reindex must refuse when MemAvailable is low");
  }
  const allowSmall = assessReindexMemory("saves", "ollama", 100, 900);
  if (allowSmall.refuse) {
    throw new Error("Small saves Ollama reindex should not hard-refuse at ~900 MB");
  }
  if (!allowSmall.warning) {
    throw new Error("Small saves Ollama reindex should soft-warn when RAM is tight");
  }
  const softVoyage = assessReindexMemory("likes", "voyage", 25_000, 4_000);
  if (softVoyage.refuse || !softVoyage.warning) {
    throw new Error("Large Voyage likes reindex should warn but not refuse at 4 GiB");
  }
  const refuseVoyageLarge = assessReindexMemory("likes", "voyage", 25_000, 800);
  if (!refuseVoyageLarge.refuse || !refuseVoyageLarge.refuseReason) {
    throw new Error("Large Voyage likes reindex must refuse below remote large floor");
  }
  const refuseCriticalVoyage = assessReindexMemory("saves", "openai", 100, 400);
  if (!refuseCriticalVoyage.refuse) {
    throw new Error("Any provider must refuse when MemAvailable is critically low");
  }
  const allowVoyageLarge = assessReindexMemory("likes", "voyage", 25_000, 1_200);
  if (allowVoyageLarge.refuse) {
    throw new Error("Large Voyage likes should be allowed above remote large floor");
  }
  if (!allowVoyageLarge.warning) {
    throw new Error("Large Voyage likes should soft-warn when allowed");
  }
  if (OLLAMA_LARGE_MIN_AVAILABLE_MB < 1024) {
    throw new Error("Ollama large threshold should be at least 1 GiB");
  }
  if (REMOTE_LARGE_MIN_AVAILABLE_MB < CRITICAL_MIN_AVAILABLE_MB) {
    throw new Error("Remote large floor must be above critical floor");
  }
  const mergedOpts = mergeNodeOptionsMaxOldSpace("--enable-source-maps", 2048);
  if (
    !mergedOpts.includes("--enable-source-maps") ||
    !mergedOpts.includes("--max-old-space-size=2048")
  ) {
    throw new Error("NODE_OPTIONS merge must append max-old-space-size");
  }
  const overrideInherited = mergeNodeOptionsMaxOldSpace(
    "--max-old-space-size=15641 --trace-warnings",
    2048,
  );
  if (
    overrideInherited.includes("--max-old-space-size=15641") ||
    !overrideInherited.includes("--max-old-space-size=2048") ||
    !overrideInherited.includes("--trace-warnings")
  ) {
    throw new Error(
      "NODE_OPTIONS merge must replace inherited max-old-space-size with the worker cap",
    );
  }

  const statusWithHost = getSearchIndexStatus();
  if (
    !statusWithHost.host ||
    typeof statusWithHost.host.ollamaLargeMinAvailableMb !== "number" ||
    typeof statusWithHost.host.criticalMinAvailableMb !== "number" ||
    typeof statusWithHost.host.remoteLargeMinAvailableMb !== "number"
  ) {
    throw new Error("Status payload must include host memory thresholds");
  }

}
