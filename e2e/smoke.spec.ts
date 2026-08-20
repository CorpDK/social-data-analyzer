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

test.describe("browse smoke", () => {
  test("/saves loads with nav and main landmark", async ({ page }) => {
    await page.goto("/saves");

    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "Saves" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Saves" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    const main = page.getByRole("main");
    await expect(main).toBeVisible();
    await expect(
      main.getByRole("heading", { level: 1, name: "Saved media" }),
    ).toBeVisible();
  });

  test("/likes loads with nav and main landmark", async ({ page }) => {
    await page.goto("/likes");

    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "Likes" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Likes" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    const main = page.getByRole("main");
    await expect(main).toBeVisible();
    await expect(
      main.getByRole("heading", { level: 1, name: "Liked media" }),
    ).toBeVisible();
  });
});

test.describe("settings smoke", () => {
  test("settings page loads", async ({ page }) => {
    await page.goto("/settings");

    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    const main = page.getByRole("main");
    await expect(main).toBeVisible();
    await expect(
      main.getByRole("heading", { level: 1, name: "Settings" }),
    ).toBeVisible();
    await expect(
      main.getByRole("heading", { name: "Your library is ready" }),
    ).toBeVisible();
    await expect(
      main.getByText("PostgreSQL connection URL"),
    ).not.toBeVisible();
  });
});

test.describe("indexes smoke", () => {
  test("indexes page loads", async ({ page }) => {
    await page.goto("/indexes");

    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "Indexes" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    const main = page.getByRole("main");
    await expect(main).toBeVisible();
    await expect(
      main.getByRole("heading", { level: 1, name: "Indexes" }),
    ).toBeVisible();
  });
});

test.describe("import smoke", () => {
  test("import page loads", async ({ page }) => {
    await page.goto("/import");

    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "Import" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    const main = page.getByRole("main");
    await expect(main).toBeVisible();
    await expect(
      main.getByRole("heading", { level: 1, name: "Import exports" }),
    ).toBeVisible();
  });
});
