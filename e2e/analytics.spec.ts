import { test, expect, type Page } from "@playwright/test";

// Analytics screenshot proofs (ENG-276), backed by the mock Supabase server.
// The mock's /__control endpoint flips the dataset between populated and empty
// so we capture both the populated screen and the new-platform all-zeros state.
test.describe.configure({ mode: "serial" });

const CONTROL = "http://127.0.0.1:8787/__control";
async function setEmpty(empty: boolean) {
  await fetch(CONTROL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ empty }),
  });
}

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.locator("#email").fill("ops@stablepass.co");
  await page.locator("#password").fill("correcthorse");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("http://127.0.0.1:3002/", { timeout: 30000 });
}

test("analytics renders populated (09-analytics)", async ({ page }) => {
  test.setTimeout(60000);
  await setEmpty(false);
  await signIn(page);
  await page.goto("/analytics");
  await expect(page.getByTestId("analytics-tiles")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("opens-by-day")).toBeVisible();
  await expect(page.getByTestId("trainer-engagement")).toBeVisible();
  await page.screenshot({ path: "e2e/__screenshots__/09-analytics.png", fullPage: true });
});

test("period toggle drives the ?period= search param", async ({ page }) => {
  test.setTimeout(60000);
  await setEmpty(false);
  await signIn(page);
  await page.goto("/analytics");
  await expect(page.getByTestId("period-toggle")).toBeVisible({ timeout: 30000 });

  // Default is 30 days; switching to 7 days must reload the server component.
  await page.getByRole("link", { name: "7 days" }).click();
  await page.waitForURL(/\/analytics\?period=7d/, { timeout: 30000 });
  await expect(page.getByRole("link", { name: "7 days" })).toHaveClass(/active/);
});

test("analytics renders the empty state", async ({ page }) => {
  test.setTimeout(60000);
  await setEmpty(true);
  await signIn(page);
  await page.goto("/analytics");
  await expect(page.getByTestId("trainers-empty")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("top-posts-empty")).toBeVisible();
  await page.screenshot({ path: "e2e/__screenshots__/09-analytics-empty.png", fullPage: true });
  await setEmpty(false);
});

test("per-post analytics renders (10-post-analytics)", async ({ page }) => {
  test.setTimeout(60000);
  await setEmpty(false);
  await signIn(page);
  await page.goto("/analytics/posts/pa1");
  await expect(page.getByTestId("post-tiles")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("post-opens")).toBeVisible();
  await expect(page.getByTestId("post-reactions")).toBeVisible();
  await page.screenshot({ path: "e2e/__screenshots__/10-post-analytics.png", fullPage: true });
});

test("a top-post row links through to its per-post page", async ({ page }) => {
  test.setTimeout(60000);
  await setEmpty(false);
  await signIn(page);
  await page.goto("/analytics");
  await expect(page.getByTestId("top-posts")).toBeVisible({ timeout: 30000 });
  await page.getByRole("link", { name: "Last fast gallop before Saturday" }).click();
  await page.waitForURL(/\/analytics\/posts\/pa1/, { timeout: 30000 });
  await expect(page.getByTestId("post-tiles")).toBeVisible();
});
