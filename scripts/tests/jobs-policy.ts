import type { TestContext } from "./harness";

/** Indexes status + background reindex job queue / cancel. */
export async function runJobsPolicyQueueSuite(_ctx: TestContext) {
  console.log("[suite] jobs-policy/queue");
  const { updateSettingsKeys } = await import("../../src/lib/settings/credentials");
  const { getSqlite } = await import("../../src/lib/db");
  const sqlite = getSqlite();

  // --- Indexes status + background reindex jobs ---
  updateSettingsKeys({
    openaiApiKey: "test-openai-key",
    voyageApiKey: "test-voyage-key",
    openaiEnabled: true,
    voyageEnabled: true,
    ollamaEnabled: true,
    localEnabled: true,
  });
  const { getSearchIndexStatus } = await import("../../src/lib/search/status");
  const {
    startReindexJob,
    waitForIdleJob,
    cancelReindexJob,
    getLatestEmbeddingJob,
    getPendingEmbeddingJobs,
    getActiveEmbeddingJob,
  } = await import("../../src/lib/search/jobs");

  const statusBefore = getSearchIndexStatus();
  if (statusBefore.providers.length !== 4) {
    throw new Error("Status should include all four embedding providers");
  }
  if (
    !statusBefore.libraries?.saves ||
    !statusBefore.libraries?.likes ||
    statusBefore.libraries.likes.providers.length !== 4
  ) {
    throw new Error("Status should include dual Saves/Likes library sections");
  }
  if (!Array.isArray(statusBefore.pendingJobs) || !Array.isArray(statusBefore.recentJobs)) {
    throw new Error("Status should include pendingJobs and recentJobs arrays");
  }
  const localStatus = statusBefore.providers.find((p) => p.provider === "local");
  if (!localStatus?.configured || localStatus.health === "unavailable") {
    throw new Error("Local provider should be enabled by default / for status test");
  }
  const openaiStatus = statusBefore.providers.find((p) => p.provider === "openai");
  if (!openaiStatus?.configured || !openaiStatus.enabled) {
    throw new Error("OpenAI should be enabled and credentialed for status test");
  }
  updateSettingsKeys({ openaiEnabled: false });
  const disabledOpenAi = getSearchIndexStatus().providers.find(
    (p) => p.provider === "openai",
  );
  if (
    disabledOpenAi?.configured ||
    disabledOpenAi?.enabled ||
    !disabledOpenAi?.hasCredentials ||
    disabledOpenAi.health !== "unavailable"
  ) {
    throw new Error(
      "Disabled OpenAI with saved credentials should report credentials + unavailable",
    );
  }
  // Disabling Saves OpenAI must not flip Likes when set independently.
  updateSettingsKeys({
    openaiEnabled: { saves: false, likes: true },
  });
  const likesOnlyOpenAi = getSearchIndexStatus().libraries.likes.providers.find(
    (p) => p.provider === "openai",
  );
  const savesOnlyOpenAi = getSearchIndexStatus().libraries.saves.providers.find(
    (p) => p.provider === "openai",
  );
  if (
    !likesOnlyOpenAi?.enabled ||
    !likesOnlyOpenAi.configured ||
    savesOnlyOpenAi?.enabled ||
    savesOnlyOpenAi?.configured
  ) {
    throw new Error(
      "Per-library OpenAI enable should differ between Saves and Likes status rows",
    );
  }
  updateSettingsKeys({ openaiEnabled: true });

  // Clear openai vectors to simulate a newly enabled / empty index.
  sqlite.exec(`DELETE FROM saved_items_vec_openai`);
  sqlite
    .prepare(`DELETE FROM embedding_index_profiles WHERE index_name = 'openai'`)
    .run();
  const emptyOpenAi = getSearchIndexStatus().providers.find(
    (p) => p.provider === "openai",
  );
  if (emptyOpenAi?.health !== "empty" || emptyOpenAi.embeddedCount !== 0) {
    throw new Error("Cleared openai index should report empty coverage");
  }

  const started = startReindexJob("openai");
  if (!started.ok) {
    throw new Error(`Failed to start openai reindex: ${started.error}`);
  }
  if (started.job.state !== "running" || started.job.target !== "openai") {
    throw new Error("Started openai job should be running");
  }
  // Different provider should enqueue behind the active job (not 409).
  const queued = startReindexJob("local");
  if (!queued.ok) {
    throw new Error(`Local reindex should enqueue while openai runs: ${queued.error}`);
  }
  if (queued.job.state !== "pending" && getPendingEmbeddingJobs().length < 1) {
    throw new Error("Local job should be pending in the queue");
  }
  const duplicate = startReindexJob("local");
  if (duplicate.ok || duplicate.status !== 409) {
    throw new Error("Duplicate local job should be rejected with 409");
  }

  const finished = await waitForIdleJob(60_000);
  if (!finished || finished.state !== "completed") {
    throw new Error(
      `Queue should finish with a completed job (got ${finished?.state}: ${finished?.error})`,
    );
  }
  const openaiAfter = getSearchIndexStatus().providers.find(
    (p) => p.provider === "openai",
  );
  if (
    openaiAfter?.health !== "ready" ||
    openaiAfter.embeddedCount !== statusBefore.totalItems
  ) {
    throw new Error("OpenAI reindex via job should restore full coverage");
  }

  // all-configured expands to one job per enabled provider × library (saves + likes).
  const allJobs = startReindexJob("all-configured");
  if (!allJobs.ok) {
    throw new Error(`Failed to start all-configured reindex: ${allJobs.error}`);
  }
  if (allJobs.jobs.length < 4) {
    throw new Error(
      `all-configured should enqueue saves+likes provider jobs (got ${allJobs.jobs.length})`,
    );
  }
  if (allJobs.jobs.some((job) => job.target === "all-configured")) {
    throw new Error("Expanded jobs must use concrete provider targets");
  }
  if (!allJobs.jobs.some((job) => job.target.startsWith("likes-"))) {
    throw new Error("all-configured should include likes-* job targets");
  }
  const activeAfterAll = getActiveEmbeddingJob();
  if (!activeAfterAll || activeAfterAll.state !== "running") {
    throw new Error("First all-configured provider job should be running");
  }
  if (getPendingEmbeddingJobs().length < 1) {
    throw new Error("Remaining all-configured providers should be pending");
  }

  // Cancel active only; queued jobs remain and continue.
  const cancelled = cancelReindexJob(activeAfterAll.id);
  if (!cancelled.ok) {
    throw new Error(`Cancel should succeed: ${cancelled.error}`);
  }
  const afterCancelSettle = await new Promise<{
    state: string;
    id: number;
  } | null>((resolve) => {
    const startedAt = Date.now();
    const tick = () => {
      // Wait until the cancelled job is terminal (next may already be running).
      const cancelledRow = sqlite
        .prepare(`SELECT id, state FROM embedding_jobs WHERE id = ?`)
        .get(activeAfterAll.id) as { id: number; state: string } | undefined;
      if (cancelledRow?.state === "cancelled") {
        resolve(cancelledRow);
        return;
      }
      if (Date.now() - startedAt > 60_000) {
        resolve(null);
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
  if (!afterCancelSettle || afterCancelSettle.state !== "cancelled") {
    throw new Error(
      `Cancelled active job should end as cancelled (got ${afterCancelSettle?.state})`,
    );
  }

  // Let the remaining queue drain so later tests see a clean runner.
  await waitForIdleJob(120_000);
  if (getLatestEmbeddingJob() == null) {
    throw new Error("Expected embedding jobs after all-configured queue");
  }

}

/** Worker spawn guards, retry classification, SSE re-entrancy. */
export async function runJobsPolicyWorkerSuite(_ctx: TestContext) {
  console.log("[suite] jobs-policy/worker");
  const { getSqlite } = await import("../../src/lib/db");
  const { updateSettingsKeys } = await import("../../src/lib/settings/credentials");
  const sqlite = getSqlite();

  // --- Worker spawn guards: terminal jobs, disabled providers, retry caps ---
  const {
    embeddingJobSpawnBlockReason,
    classifyWorkerExit,
    planWorkerRetry,
    embeddingWorkerRetryDelayMs,
    MAX_EMBEDDING_WORKER_ATTEMPTS,
    EMBEDDING_WORKER_FAST_FAILURE_MS,
    ensureJobRunner,
    getEmbeddingJob,
    startReindexJob,
    waitForIdleJob,
  } = await import("../../src/lib/search/jobs");

  const insertJobRow = (target: string, state: string): number => {
    const info = sqlite
      .prepare(
        `INSERT INTO embedding_jobs(target, state, phase, processed, total, message)
         VALUES (?, ?, 'queued', 0, 0, 'synthetic test row')`,
      )
      .run(target, state);
    return Number(info.lastInsertRowid);
  };

  const failedJobId = insertJobRow("local", "failed");
  const failedReason = embeddingJobSpawnBlockReason(failedJobId);
  if (!failedReason || !failedReason.includes("failed")) {
    throw new Error("A failed job must never be startable by a worker");
  }
  ensureJobRunner();
  if (getEmbeddingJob(failedJobId)?.state !== "failed") {
    throw new Error("Terminal jobs must not be revived by the queue");
  }
  if (embeddingJobSpawnBlockReason(failedJobId + 10_000) === null) {
    throw new Error("A missing job must never be startable");
  }

  // A provider disabled after enqueue must fail its queued job, not spawn for it.
  updateSettingsKeys({ voyageEnabled: false });
  const staleVoyageJobId = insertJobRow("voyage", "pending");
  const staleReason = embeddingJobSpawnBlockReason(staleVoyageJobId);
  if (!staleReason || !staleReason.includes("not enabled")) {
    throw new Error(
      `Queued job for a disabled provider must be blocked (got ${staleReason})`,
    );
  }
  ensureJobRunner();
  const staleVoyageJob = getEmbeddingJob(staleVoyageJobId);
  if (staleVoyageJob?.state !== "failed" || !staleVoyageJob.error) {
    throw new Error(
      `Stale disabled-provider job should fail terminally (got ${staleVoyageJob?.state})`,
    );
  }
  updateSettingsKeys({ voyageEnabled: true });

  const enabledLocalJobId = insertJobRow("local", "pending");
  if (embeddingJobSpawnBlockReason(enabledLocalJobId) !== null) {
    throw new Error("An enabled provider's pending job should be startable");
  }
  sqlite
    .prepare(
      `UPDATE embedding_jobs SET state = 'cancelled', finished_at = unixepoch() WHERE id = ?`,
    )
    .run(enabledLocalJobId);
  if (embeddingJobSpawnBlockReason(enabledLocalJobId) === null) {
    throw new Error("A cancelled job must never be startable");
  }

  // Retry classification: only slow, non-cancelled failures may respawn.
  if (
    classifyWorkerExit({ code: 0, signal: null, elapsedMs: 10_000 }) !== "ok"
  ) {
    throw new Error("Exit code 0 should classify as ok");
  }
  if (
    classifyWorkerExit({
      code: 1,
      signal: null,
      elapsedMs: EMBEDDING_WORKER_FAST_FAILURE_MS - 1,
    }) !== "permanent"
  ) {
    throw new Error("Instant worker failures must be permanent (no respawn)");
  }
  if (
    classifyWorkerExit({ code: 3, signal: null, elapsedMs: 60_000 }) !==
    "permanent"
  ) {
    throw new Error("Worker exit code 3 must be permanent");
  }
  if (
    classifyWorkerExit({
      code: 1,
      signal: null,
      elapsedMs: 30_000,
      cancelRequested: true,
    }) !== "cancelled"
  ) {
    throw new Error("Cancelled runs must not be retried as failures");
  }
  if (
    classifyWorkerExit({ code: null, signal: null, elapsedMs: 5, spawnFailed: true }) !==
    "permanent"
  ) {
    throw new Error("Spawn failures must be permanent");
  }
  const transientExit = classifyWorkerExit({
    code: 1,
    signal: null,
    elapsedMs: 30_000,
  });
  if (transientExit !== "transient") {
    throw new Error("Slow non-zero exits should be retryable");
  }

  const firstRetry = planWorkerRetry(1, "transient");
  const secondRetry = planWorkerRetry(2, "transient");
  const cappedRetry = planWorkerRetry(MAX_EMBEDDING_WORKER_ATTEMPTS, "transient");
  if (!firstRetry.retry || firstRetry.delayMs < 1_000) {
    throw new Error("First transient failure should retry after a backoff");
  }
  if (!secondRetry.retry || secondRetry.delayMs <= firstRetry.delayMs) {
    throw new Error("Backoff must grow between attempts");
  }
  if (cappedRetry.retry) {
    throw new Error(
      `Retries must stop at ${MAX_EMBEDDING_WORKER_ATTEMPTS} attempts`,
    );
  }
  if (planWorkerRetry(1, "permanent").retry) {
    throw new Error("Permanent failures must never retry");
  }
  if (embeddingWorkerRetryDelayMs(1) !== 1_000) {
    throw new Error("First retry backoff should be 1s");
  }
  if (embeddingWorkerRetryDelayMs(99) < embeddingWorkerRetryDelayMs(2)) {
    throw new Error("Backoff lookup should clamp to the longest delay");
  }

  // --- SSE re-entrancy: a status subscriber must not re-queue a claimed job ---
  // This mirrors the /api/search/status/stream handler, whose every snapshot
  // calls ensureJobRunner(). Job writes publish synchronously, so an unclaimed
  // runner used to re-queue the row it had just started and start it again.
  const { subscribeJobEvents, SEARCH_STATUS_CHANNEL } = await import(
    "../../src/lib/sse"
  );
  let maxConcurrentRunning = 0;
  let reentrantPumps = 0;
  const unsubscribeStatus = subscribeJobEvents(SEARCH_STATUS_CHANNEL, () => {
    reentrantPumps += 1;
    const running = (
      sqlite
        .prepare(`SELECT count(*) AS c FROM embedding_jobs WHERE state = 'running'`)
        .get() as { c: number }
    ).c;
    maxConcurrentRunning = Math.max(maxConcurrentRunning, running);
    ensureJobRunner();
  });

  try {
    const reentrant = startReindexJob("local");
    if (!reentrant.ok) {
      throw new Error(`Reentrancy job should start: ${reentrant.error}`);
    }
    const reentrantSettled = await waitForIdleJob(60_000);
    if (reentrantSettled?.state !== "completed") {
      throw new Error(
        `Job should complete once with SSE subscribers attached (got ${reentrantSettled?.state}: ${reentrantSettled?.error})`,
      );
    }
    if (reentrantPumps === 0) {
      throw new Error("Expected the status subscriber to observe job events");
    }
    if (maxConcurrentRunning > 1) {
      throw new Error(
        `Only one job may run at a time (saw ${maxConcurrentRunning})`,
      );
    }
    const reentrantJob = getEmbeddingJob(reentrant.job.id);
    if (reentrantJob?.state !== "completed") {
      throw new Error(
        `Re-entrancy guard job should end completed (got ${reentrantJob?.state})`,
      );
    }
  } finally {
    unsubscribeStatus();
  }

}
