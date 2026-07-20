import { test, expect } from "@playwright/test";

// Manual races (ENG-180 / RF6) — the fallback console. Screenshot proofs for the
// list, the create form and the per-race manage screen, backed by the mock
// Supabase server from global-setup.ts. Seeded fixtures only; no real data.
test.describe.configure({ mode: "serial" });

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/signin");
  await page.locator("#email").fill("ops@stablepass.co");
  await page.locator("#password").fill("correcthorse");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("http://127.0.0.1:3002/", { timeout: 30000 });
}

test("manual races — populated list shows provenance", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);

  await page.goto("/racing-manual");
  await expect(page.locator(".adm-table")).toBeVisible({ timeout: 30000 });

  // The three provenance states the screen exists to distinguish.
  await expect(page.getByText("Randwick R5")).toBeVisible();
  await expect(page.locator(".pill", { hasText: "Manual" }).first()).toBeVisible();
  await expect(page.locator(".pill", { hasText: "Feed · overridden" }).first()).toBeVisible();

  await page.screenshot({ path: "e2e/__screenshots__/20-racing-manual-list.png", fullPage: true });
});

test("manual races — filter chips narrow the list", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);

  await page.goto("/racing-manual?filter=overridden");
  await expect(page.locator(".chip.active")).toHaveText(/Overridden/);
  await page.screenshot({ path: "e2e/__screenshots__/21-racing-manual-overridden.png", fullPage: true });
});

test("manual races — new race form", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);

  await page.goto("/racing-manual/new");
  await expect(page.locator("#venue")).toBeVisible({ timeout: 30000 });
  await page.locator("#venue").fill("Rosehill");
  await page.locator("#raceDate").fill("2026-09-12");
  await page.locator("#raceNumber").fill("6");
  await page.locator("#raceClass").fill("BM70");
  await page.locator("#distanceM").fill("1300");

  await page.screenshot({ path: "e2e/__screenshots__/22-racing-manual-new.png", fullPage: true });
});

test("manual races — manage a race: correct, runners, result", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);

  await page.goto("/racing-manual/mr1");
  await expect(page.getByRole("heading", { name: "Correct this race" })).toBeVisible({ timeout: 30000 });

  // Runners table: one still open for a result, one already recorded.
  await expect(page.getByText("MAHOGANY (AUS)")).toBeVisible();
  await expect(page.locator(".pill", { hasText: "Ran" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Record" }).first()).toBeVisible();

  await page.screenshot({ path: "e2e/__screenshots__/23-racing-manual-detail.png", fullPage: true });
});

// The override notice is the load-bearing copy on this screen: correcting a feed
// row pins it, and deleting an uncorrected feed row invites the poll to re-create it.
test("manual races — feed race shows the override notice", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);

  await page.goto("/racing-manual/mr2");
  await expect(page.locator(".rm-notice")).toContainText("pinned");
  await page.screenshot({ path: "e2e/__screenshots__/24-racing-manual-override-notice.png", fullPage: true });
});
