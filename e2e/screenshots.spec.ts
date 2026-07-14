import { test, expect } from "@playwright/test";

// Auth-shell screenshot proofs, backed by the mock Supabase server started
// in global-setup.ts. Run serially: test 2 signs in and relies on test 1's
// context being separate from test 3's fresh (unauthenticated) context.
test.describe.configure({ mode: "serial" });

test("signin screen renders with no backend session", async ({ page }) => {
  await page.goto("/signin");
  await expect(page.locator(".admin-signin-card")).toBeVisible();
  await page.screenshot({ path: "e2e/__screenshots__/01-signin.png" });
});

test("admin can sign in and reach the gated dashboard shell", async ({ page }) => {
  test.setTimeout(60000);
  await page.goto("/signin");
  await page.locator("#email").fill("ops@stablepass.co");
  await page.locator("#password").fill("correcthorse");
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.waitForURL("http://127.0.0.1:3002/", { timeout: 30000 });
  await expect(page.locator(".admin-shell")).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/02-dashboard-shell.png" });
});

test("no session at / redirects to /signin", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("/");
  await page.waitForURL(/\/signin/, { timeout: 30000 });
  expect(page.url()).toContain("/signin");
  await page.screenshot({ path: "e2e/__screenshots__/03-gate-redirect.png" });

  await context.close();
});
