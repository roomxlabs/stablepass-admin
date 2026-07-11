import { test, expect, type Page } from "@playwright/test";

// Dashboard screenshot proof (ENG-174 / T4). Backed by the mock Supabase server
// in e2e/global-setup.ts, extended with the dashboard tables (post / reaction /
// bookmark / subscription / race). Serial: signs in on its own fresh context.
test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.locator("#email").fill("ops@stablepass.co");
  await page.locator("#password").fill("correcthorse");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("http://127.0.0.1:3002/", { timeout: 30000 });
}

test("dashboard — tiles + race day + quiet horses + recently published", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/");

  // Tiles + race-day queue + recently-published table all populated.
  await expect(page.locator(".adm-stats .adm-stat").first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".adm-race-row").first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".adm-quiet-row").first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".adm-table tbody tr").first()).toBeVisible({ timeout: 30000 });

  await page.screenshot({ path: "e2e/__screenshots__/02-dashboard.png", fullPage: true });
});
