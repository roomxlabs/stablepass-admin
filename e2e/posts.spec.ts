import { test, expect, type Page } from "@playwright/test";

// Posts library screenshot proofs (ENG-177 / T7). Backed by the mock Supabase
// server in e2e/mock-supabase.mjs (post fixtures + count header). Serial: each
// test signs in on its own fresh context.
test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.locator("#email").fill("ops@stablepass.co");
  await page.locator("#password").fill("correcthorse");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("http://127.0.0.1:3002/", { timeout: 30000 });
}

test("posts library — populated", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/posts");
  await expect(page.locator(".adm-table tbody tr").first()).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/04-posts-list.png", fullPage: true });
});

test("posts library — empty", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/posts?q=__none__");
  await expect(page.locator(".posts-empty")).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/04-posts-empty.png", fullPage: true });
});
