import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";

/**
 * E2E against the Next app on loopback.
 * Prefer an already-running `pnpm dev`, or let Playwright start one via webServer.
 * See docs/testing.md.
 *
 * When webServer starts the app, use an isolated temp DB so import flows do not
 * touch the operator’s real library. reuseExistingServer skips that isolation.
 */
const e2eDbPath = path.join(
  os.tmpdir(),
  `instagram-saves-e2e-${process.pid}.db`,
);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      INSTAGRAM_SAVES_DB: e2eDbPath,
      INSTAGRAM_SAVES_KEYRING: "memory",
      EMBEDDING_WORKER_INLINE: "1",
    },
  },
});
