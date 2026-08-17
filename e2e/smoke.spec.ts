import { expect, test } from "@playwright/test";

test.describe("shell smoke", () => {
  test("home page loads with brand and primary nav", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveTitle(/Instagram Saves/i);
    await expect(page.getByText("Saves Ledger")).toBeVisible();

    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "Overview" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Indexes" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Settings" })).toBeVisible();
  });
});
