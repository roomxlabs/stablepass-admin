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
  expect(lines[0]).toBe("name,email,status,provider,period,started_at,tenure_months,current_period_end,canceled_at");
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

test("subscribers — Billed via: column, chips, and the provider filter narrows (ENG-1193)", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/subscribers");
  await expect(page.locator(".adm-table")).toBeVisible({ timeout: 30000 });

  // The column sits right after Status, and every channel label appears —
  // including the NULL-provider fixture (Tom), which must read "Web".
  const headers = await page.locator(".adm-table thead th").allTextContents();
  expect(headers.indexOf("Billed via")).toBe(headers.indexOf("Status") + 1);
  await expect(
    page.getByTestId("subscriber-row").filter({ hasText: "tom@example.com" }).getByTestId("subscriber-provider"),
  ).toHaveText("Web");
  for (const label of ["Web", "App Store", "Google Play", "Complimentary"]) {
    await expect(page.getByTestId("subscriber-provider").filter({ hasText: label }).first()).toBeVisible();
  }

  await page.getByTestId("provider-filter-app_store").click();
  await page.waitForURL("**/subscribers?provider=app_store", { timeout: 30000 });

  // Harriet (active) and Douglas (cancelled) are the two App Store fixtures.
  await expect(page.locator(".adm-table tbody tr")).toHaveCount(2);
  await expect(page.getByTestId("subscriber-provider")).toHaveText(["App Store", "App Store"]);
  await expect(page.locator(".adm-table tbody")).toContainText("harriet@example.com");
  await expect(page.locator(".adm-table tbody")).toContainText("douglas@example.com");
  await expect(page.getByTestId("provider-filter-app_store")).toHaveClass(/active/);
  // The headline stays the unfiltered total.
  await expect(page.getByTestId("subscribers-total")).toContainText("8");

  await page.screenshot({
    path: "e2e/__screenshots__/46-subscribers-provider.png",
    fullPage: true,
  });

  // Combines with status: cancelled AND App Store is Douglas alone.
  await page.getByTestId("status-filter-canceled").click();
  await page.waitForURL("**/subscribers?status=canceled&provider=app_store", { timeout: 30000 });
  await expect(page.locator(".adm-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".adm-table tbody")).toContainText("douglas@example.com");
});

test("subscribers — an unknown ?provider= is ignored, not an unclearable filter", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/subscribers?provider=xyz");
  await expect(page.locator(".adm-table tbody tr")).toHaveCount(8, { timeout: 30000 });
  await expect(page.getByTestId("provider-filter-any")).toHaveClass(/active/);
});

test("subscribers — CSV export carries the provider column and honours the provider filter", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/subscribers?provider=play_store");

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    page.getByTestId("subscribers-export").click(),
  ]);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk as Buffer);
  const lines = Buffer.concat(chunks).toString("utf8").trim().split(/\r\n/);

  expect(lines[0]).toBe("name,email,status,provider,period,started_at,tenure_months,current_period_end,canceled_at");
  // Header + Rafael (lapsed) and Simone (cancelled), the two Google Play rows.
  expect(lines).toHaveLength(3);
  const byEmail = new Map(lines.slice(1).map((l) => [l.split(",")[1], l.split(",")]));
  expect(byEmail.get("rafael@example.com")?.[3]).toBe("play_store");
  expect(byEmail.get("simone@example.com")?.[3]).toBe("play_store");
});

test("subscribers — Trial / Paid: status-cell label, chips, and the period filter narrows (ENG-1329)", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/subscribers");
  await expect(page.locator(".adm-table")).toBeVisible({ timeout: 30000 });

  // Simone (canceled, play_store) has a NULL period_type and must read "Unknown".
  await expect(
    page.getByTestId("subscriber-row-cancelled").filter({ hasText: "simone@example.com" }).getByTestId("subscriber-period"),
  ).toHaveText("Unknown");

  // The period rides in the Status cell, not a ninth column, so the Comp
  // column must still sit fully inside the card at the 1280px viewport — a
  // ninth column pushed Comp/Revoke past the card's overflow clip.
  const card = await page.locator(".adm-card").boundingBox();
  const compHeader = await page.locator(".adm-table th.subs-comp").boundingBox();
  expect(card && compHeader).toBeTruthy();
  expect(compHeader!.x + compHeader!.width).toBeLessThanOrEqual(card!.x + card!.width);
  await page.screenshot({ path: "e2e/__screenshots__/48-subscribers-period-all.png", fullPage: true });

  await page.getByTestId("period-filter-trial").click();
  await page.waitForURL("**/subscribers?period=trial", { timeout: 30000 });

  // Tom and Priya are the two Pricing v2 trialists (status active, period trial).
  await expect(page.locator(".adm-table tbody tr")).toHaveCount(2);
  await expect(page.getByTestId("subscriber-period")).toHaveText(["Trial", "Trial"]);
  await expect(page.locator(".adm-table tbody")).toContainText("tom@example.com");
  await expect(page.locator(".adm-table tbody")).toContainText("priya@example.com");
  await expect(page.getByTestId("period-filter-trial")).toHaveClass(/active/);
  // The headline stays the unfiltered total.
  await expect(page.getByTestId("subscribers-total")).toContainText("8");

  await page.screenshot({
    path: "e2e/__screenshots__/48-subscribers-period.png",
    fullPage: true,
  });
});

test("subscribers — CSV export carries the period column and honours the period filter", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/subscribers?period=trial");

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    page.getByTestId("subscribers-export").click(),
  ]);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk as Buffer);
  const lines = Buffer.concat(chunks).toString("utf8").trim().split(/\r\n/);

  expect(lines[0]).toBe("name,email,status,provider,period,started_at,tenure_months,current_period_end,canceled_at");
  // Header + Tom and Priya, the two Trial rows.
  expect(lines).toHaveLength(3);
  const byEmail = new Map(lines.slice(1).map((l) => [l.split(",")[1], l.split(",")]));
  expect(byEmail.get("tom@example.com")?.[4]).toBe("Trial");
  expect(byEmail.get("priya@example.com")?.[4]).toBe("Trial");
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

  // The redirect alone does not earn the second half of this test's name
  // (ENG-982 review @3f9cf51, should-fix 3): a page that redirected but still
  // streamed the subscriber list in its markup would have passed. Assert the
  // content too — no member email, name, or table anywhere in what was served.
  const html = await page.content();
  for (const pii of [
    "harriet@example.com",
    "Harriet Vale",
    "douglas@example.com",
    "Douglas Byrne",
  ]) {
    expect(html).not.toContain(pii);
  }
  await expect(page.locator(".adm-table")).toHaveCount(0);

  await context.close();
});

// ---------------------------------------------------------------------------
// Comp access (ENG-1194). The BFF calls RevenueCat SERVER-side, so the browser
// cannot stub RevenueCat itself: the grant/revoke tests stub the admin comp
// endpoint with page.route and assert what the UI SENT. The last test leaves the
// endpoint unstubbed on purpose — the e2e server has no RevenueCat key, so the
// REAL route (behind the real admin gate) must answer 503 and the UI must say so.
// ---------------------------------------------------------------------------

const PRIYA_UID = "00000000-0000-4000-8000-000000000003"; // sub-3, promotional + active
const HARRIET_UID = "00000000-0000-4000-8000-000000000001"; // sub-1, app_store

test("subscribers — Comp: inline duration confirm, POST carries the chosen duration, toast (ENG-1194)", async ({
  page,
}) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/subscribers");
  await expect(page.locator(".adm-table")).toBeVisible({ timeout: 30000 });

  const headers = await page.locator(".adm-table thead th").allTextContents();
  expect(headers[headers.length - 1].trim()).toBe("Comp");
  // Revoke only on the one live complimentary row (Priya).
  await expect(page.getByTestId("comp-revoke")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Revoke complimentary access for Priya Raman" })).toBeVisible();

  const sent: { url: string; method: string; body: unknown }[] = [];
  await page.route("**/api/admin/subscribers/*/comp", async (route) => {
    const req = route.request();
    sent.push({ url: req.url(), method: req.method(), body: req.postDataJSON() });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { granted: true, duration: "three_month" } }),
    });
  });

  await page.getByRole("button", { name: "Comp access for Harriet Vale" }).click();
  const confirm = page.getByTestId("comp-confirm");
  await expect(confirm).toBeVisible();
  // Nothing is sent by opening the confirm.
  expect(sent).toEqual([]);
  await confirm.getByTestId("comp-duration").selectOption("three_month");

  await page.screenshot({ path: "e2e/__screenshots__/47-eng1194-subscribers-comp-confirm.png", fullPage: true });

  await confirm.getByTestId("comp-grant").click();
  await expect(page.getByTestId("adm-toast").filter({ hasText: "Complimentary access granted" })).toBeVisible();
  expect(sent).toEqual([
    {
      url: `http://127.0.0.1:3002/api/admin/subscribers/${HARRIET_UID}/comp`,
      method: "POST",
      body: { duration: "three_month" },
    },
  ]);
  await expect(page.getByTestId("comp-confirm")).toHaveCount(0);

  await page.screenshot({ path: "e2e/__screenshots__/47-eng1194-subscribers-comp-granted.png", fullPage: true });
});

test("subscribers — Revoke on a complimentary row: confirm, DELETE, toast (ENG-1194)", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/subscribers");
  await expect(page.locator(".adm-table")).toBeVisible({ timeout: 30000 });

  const methods: string[] = [];
  await page.route(`**/api/admin/subscribers/${PRIYA_UID}/comp`, async (route) => {
    methods.push(route.request().method());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { revoked: true } }) });
  });

  let dialogText = "";
  page.once("dialog", async (d) => {
    dialogText = d.message();
    await d.accept();
  });
  await page.getByTestId("comp-revoke").click();
  await expect(page.getByTestId("adm-toast").filter({ hasText: "Complimentary access revoked" })).toBeVisible();
  expect(dialogText).toContain("Revoke complimentary access for Priya Raman?");
  expect(methods).toEqual(["DELETE"]);
});

test("subscribers — Comp against the REAL route with no RevenueCat key → 503 copy (ENG-1194)", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/subscribers");
  await expect(page.locator(".adm-table")).toBeVisible({ timeout: 30000 });

  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(`/api/admin/subscribers/${HARRIET_UID}/comp`)),
    (async () => {
      await page.getByRole("button", { name: "Comp access for Harriet Vale" }).click();
      await page.getByTestId("comp-grant").click();
    })(),
  ]);
  expect(res.status()).toBe(503);
  expect((await res.json()).error.code).toBe("revenuecat_not_configured");
  await expect(page.getByTestId("adm-toast").filter({ hasText: "isn't configured on this server" })).toBeVisible();
  // The confirm stays open so the operator can retry once it is configured.
  await expect(page.getByTestId("comp-confirm")).toBeVisible();

  await page.screenshot({ path: "e2e/__screenshots__/47-eng1194-subscribers-comp-error.png", fullPage: true });
});
