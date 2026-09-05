import { test, expect, type Page } from "@playwright/test";

// Subscribers screenshot proofs (ENG-982). Backed by the mock Supabase server's
// SUBSCRIPTION_FIXTURES: eight member subscriptions spanning all four of today's
// statuses and a spread of tenures, plus the operator's own subscription, which
// must never appear. Serial: each test signs in on its own fresh context.
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

test("subscribers — populated, with cancellations visible on arrival", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/subscribers");

  await expect(page.locator(".adm-table")).toBeVisible({ timeout: 30000 });

  // Eight member subscriptions — the ninth fixture is the operator's, and the
  // staff-exclusion guardrail (ENG-315) keeps it off the screen entirely.
  await expect(page.locator(".adm-table tbody tr")).toHaveCount(8);
  await expect(page.getByTestId("subscribers-total")).toContainText("8");
  // Scoped to the TABLE, not the page: the sidebar legitimately shows the
  // signed-in operator's own address, so asserting over `body` would fail on
  // the sidebar while proving nothing about the list. What the guardrail
  // requires is that the operator is not a ROW.
  await expect(page.locator(".adm-table tbody")).not.toContainText("ops@stablepass.co");
  await expect(page.locator(".adm-table tbody")).not.toContainText("StablePass Ops");

  // THE ACCEPTANCE CRITERION: a cancelled subscriber is visible without opening
  // anything — two of them, each with a red pill and a cancellation date, in the
  // default unfiltered view.
  await expect(page.getByTestId("subscriber-row-cancelled")).toHaveCount(2);
  await expect(page.locator(".pill.red").first()).toHaveText("Cancelled");
  await expect(page.locator(".subs-cancelled-on time").first()).not.toBeEmpty();

  // Copy: this view talks about subscribers, never "trials" as a framing.
  await expect(page.locator(".admin-topbar h1")).toHaveText("Subscribers");

  await page.screenshot({
    path: "e2e/__screenshots__/13-subscribers-list.png",
    fullPage: true,
  });
});

test("subscribers — the cancelled cohort, which is what Mel opens this for", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/subscribers");
  await page.getByTestId("status-filter-canceled").click();
  await page.waitForURL("**/subscribers?status=canceled", { timeout: 30000 });

  await expect(page.locator(".adm-table tbody tr")).toHaveCount(2);
  await expect(page.getByTestId("subscriber-row-cancelled")).toHaveCount(2);
  // The headline count stays the UNFILTERED total, so filtering never looks
  // like the subscriber base shrank.
  await expect(page.getByTestId("subscribers-total")).toContainText("8");
  await expect(page.locator(".subscribers-foot")).toContainText("Showing 2 of 2 subscribers");

  await page.screenshot({
    path: "e2e/__screenshots__/13-subscribers-cancelled.png",
    fullPage: true,
  });
});

test("subscribers — tenure filter returns the right cohort", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/subscribers");
  await page.getByTestId("tenure-filter-12").click();
  await page.waitForURL("**/subscribers?band=12", { timeout: 30000 });

  // Only the 14- and 19-month subscriptions clear 12 months.
  await expect(page.locator(".adm-table tbody tr")).toHaveCount(2);
  await expect(page.locator(".adm-table tbody")).toContainText("harriet@example.com");
  await expect(page.locator(".adm-table tbody")).toContainText("mei.lin@example.com");
  // The 8-month subscriber is NOT in this cohort.
  await expect(page.locator(".adm-table tbody")).not.toContainText("tom@example.com");

  await page.screenshot({
    path: "e2e/__screenshots__/13-subscribers-tenure.png",
    fullPage: true,
  });
});

test("subscribers — CSV export covers the filtered set, not the visible page", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/subscribers?status=canceled");

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    page.getByTestId("subscribers-export").click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/^subscribers-\d{4}-\d{2}-\d{2}\.csv$/);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk as Buffer);
  const csv = Buffer.concat(chunks).toString("utf8");

  const lines = csv.trim().split(/\r\n/);
  expect(lines[0]).toBe("name,email,status,started_at,tenure_months,current_period_end,canceled_at");
  // Header + exactly the two cancelled subscribers — the export honours the
  // filter rather than dumping the whole base.
  expect(lines).toHaveLength(3);
  expect(csv).toContain("douglas@example.com");
  expect(csv).toContain("simone@example.com");
  expect(csv).not.toContain("harriet@example.com");
});

test("subscribers — the UNFILTERED export still excludes the operator", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  // Deliberately unfiltered. Asserting the staff guardrail on the ?status=canceled
  // export proves nothing: the operator fixture is `active`, so the status filter
  // alone would exclude it and a broken staff filter would still look green. Only
  // an export with NO filters actually exercises the exclusion.
  await page.goto("/subscribers");

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    page.getByTestId("subscribers-export").click(),
  ]);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk as Buffer);
  const csv = Buffer.concat(chunks).toString("utf8");

  // Header + the 8 member subscriptions, and NOT the operator's 9th.
  expect(csv.trim().split(/\r\n/)).toHaveLength(9);
  expect(csv).not.toContain("ops@stablepass.co");
  expect(csv).not.toContain("StablePass Ops");
  expect(csv).toContain("harriet@example.com");
});

test("subscribers — empty state", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/subscribers?q=__none__");
  await expect(page.locator(".adm-empty")).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".adm-empty")).toContainText("No subscribers match these filters");
  await page.screenshot({
    path: "e2e/__screenshots__/13-subscribers-empty.png",
    fullPage: true,
  });
});

test("subscribers — a signed-out visitor is redirected, never shown member emails", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("/subscribers");
  await page.waitForURL(/\/signin/, { timeout: 30000 });
  expect(page.url()).toContain("/signin");

  await context.close();
});
