import { test, expect, type Page } from "@playwright/test";

// Waitlist screenshot proofs (ENG-976). Backed by the mock Supabase server in
// e2e/global-setup.ts, which serves 28 fake signups — more than one 25-row page,
// so the pager and the "export covers more than the visible page" claim are both
// provable here. Serial: each test signs in on its own fresh context.
test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.locator("#email").fill("ops@stablepass.co");
  await page.locator("#password").fill("correcthorse");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("**/signin/mfa", { timeout: 30000 });
  await page.locator("#code").fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL("http://127.0.0.1:3002/", { timeout: 30000 });
}

test("waitlist — populated, with the headline count and the pager", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/waitlist");

  await expect(page.locator(".adm-table")).toBeVisible({ timeout: 30000 });

  // The headline count is every signup (28), while the page shows one 25-row
  // page — the distinction Mel watches climb.
  await expect(page.locator(".adm-filter-bar .chip.active")).toContainText("28");
  await expect(page.locator(".adm-table tbody tr")).toHaveCount(25);
  await expect(page.locator(".waitlist-foot")).toContainText("Showing 25 of 28 signups");

  // Real addresses render, not blank rows.
  await expect(page.locator(".adm-table tbody tr").first()).toContainText("@example.com");

  // Page 1: Prev is inert, Next is live.
  await expect(page.locator(".waitlist-foot .pager span.disabled")).toHaveText("‹ Prev");
  await expect(page.locator(".waitlist-foot .pager a")).toHaveText("Next ›");

  await page.screenshot({ path: "e2e/__screenshots__/11-waitlist-list.png", fullPage: true });
});

test("waitlist — page 2 via the pager", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/waitlist");
  await page.locator(".waitlist-foot .pager a").click();
  await page.waitForURL("**/waitlist?offset=25", { timeout: 30000 });

  // The 28th..26th rows — the ones the CSV must include and the first page does not.
  await expect(page.locator(".adm-table tbody tr")).toHaveCount(3);
  await expect(page.locator(".waitlist-foot .pager span.disabled")).toHaveText("Next ›");

  await page.screenshot({ path: "e2e/__screenshots__/11-waitlist-page2.png", fullPage: true });
});

test("waitlist — CSV export downloads every row, not just the visible page", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/waitlist");

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    page.getByTestId("waitlist-export").click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/^waitlist-\d{4}-\d{2}-\d{2}\.csv$/);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const csv = Buffer.concat(chunks).toString("utf8");

  // Header line, then every one of the 28 rows — including the three that only
  // exist on page 2. This is the acceptance criterion the ticket names.
  const lines = csv.trim().split(/\r\n/);
  expect(lines[0]).toBe("email,source,joined_at");
  expect(lines).toHaveLength(29);
});

test("waitlist — empty state", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/waitlist?q=__none__");
  await expect(page.locator(".adm-empty")).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/11-waitlist-empty.png", fullPage: true });
});

test("waitlist — a signed-out visitor is redirected, never shown addresses", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("/waitlist");
  await page.waitForURL(/\/signin/, { timeout: 30000 });
  expect(page.url()).toContain("/signin");

  await context.close();
});
