/**
 * Thin aggregator for Gate A focused suites.
 * Runs parse → jobs-policy → memory-gates → sync-upsert → import-safety in
 * the historical order (shared temp DB / sequential state).
 */
import { setupTestContext } from "./tests/harness";
import { runParseSuite } from "./tests/parse";
import { runParseEdgesSuite } from "./tests/parse-edges";
import {
  runJobsPolicyQueueSuite,
  runJobsPolicyWorkerSuite,
} from "./tests/jobs-policy";
import { runMemoryGatesSuite } from "./tests/memory-gates";
import {
  runSyncUpsertResumeSuite,
  runSyncUpsertChunkedSuite,
} from "./tests/sync-upsert";
import { runImportSafetySuite } from "./tests/import-safety";

async function main() {
  const ctx = await setupTestContext();
  try {
    await runParseSuite(ctx);
    await runParseEdgesSuite(ctx);
    await runJobsPolicyQueueSuite(ctx);
    await runMemoryGatesSuite(ctx);
    await runSyncUpsertResumeSuite(ctx);
    await runJobsPolicyWorkerSuite(ctx);
    await runImportSafetySuite(ctx);
    await runSyncUpsertChunkedSuite(ctx);
    console.log("ok");
  } finally {
    ctx.cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
