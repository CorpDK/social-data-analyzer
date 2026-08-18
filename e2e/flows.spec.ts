import { expect, test } from "@playwright/test";
import path from "node:path";

const zipFixture = path.join(
  __dirname,
  "fixtures",
  "sample-saved-posts.zip",
);

test.describe("import zip flow", () => {
  test("uploads small zip and shows progress settling", async ({ page }) => {
    await page.goto("/import");

    const main = page.getByRole("main");
    await expect(
      main.getByRole("heading", { level: 1, name: "Import exports" }),
    ).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles(zipFixture);
    await page.getByRole("button", { name: /Import into library/i }).click();

    // Progress region appears (202 accepted → SSE/poll)
    const progress = page.locator("#import-progress-heading");
    await expect(progress).toBeVisible({ timeout: 30_000 });

    // Settle: completed or history refresh; poll jobs API as backup signal
    await expect
      .poll(
        async () => {
          const res = await page.request.get("/api/import/jobs");
          if (!res.ok()) return "http-error";
          const body = (await res.json()) as {
            activeJob: { state: string } | null;
            pendingJobs: unknown[];
          };
          if (body.activeJob || (body.pendingJobs?.length ?? 0) > 0) {
            return "busy";
          }
          return "idle";
        },
        { timeout: 90_000 },
      )
      .toBe("idle");

    // History table should mention the fixture name or completed status
    await expect(main.getByText(/sample-saved-posts|completed|Imported/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });
});

test.describe("settings validation", () => {
  test("rejects invalid timeout without applying", async ({ page }) => {
    await page.goto("/settings");
    const main = page.getByRole("main");
    await expect(
      main.getByRole("heading", { level: 1, name: "Settings" }),
    ).toBeVisible();

    const timeout = main.locator('input[name="timeoutMs"]');
    const save = main.getByRole("button", { name: "Save settings" });
    // Wait for settings hydrate so a late load() cannot overwrite the fill.
    await expect(save).toBeEnabled({ timeout: 30_000 });
    await expect(timeout).toHaveValue(/^[1-9]\d*$/);

    // HTML5 min=1 would block submit; disable native validation so client checks run.
    await timeout.evaluate((el: HTMLInputElement) => {
      const form = el.closest("form");
      if (form) form.noValidate = true;
    });
    await timeout.fill("0");
    await expect(timeout).toHaveValue("0");

    await save.click();

    await expect(
      main.getByText(/Timeout must be a positive number of milliseconds/i),
    ).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("browse filters", () => {
  test("filter form submits and updates URL", async ({ page }) => {
    await page.goto("/saves");
    const main = page.getByRole("main");
    await expect(
      main.getByRole("heading", { level: 1, name: "Saved media" }),
    ).toBeVisible();

    const q = page.locator('input[name="q"]');
    await q.fill("nature");
    await page.getByRole("button", { name: /Apply filters/i }).click();

    await expect(page).toHaveURL(/q=nature/);
    // Result list or empty state still renders inside main
    await expect(main).toBeVisible();
  });
});
