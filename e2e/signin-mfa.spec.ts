import { test, expect } from "@playwright/test";

// Two-step sign-in (ENG-370): /signin (email+password) -> /signin/mfa (TOTP
// code) -> "/". Backed by the mock Supabase server in e2e/global-setup.ts,
// extended for this ticket with a stateful AAL + the audit RPCs. Serial: later
// tests assert on the /__audit log the earlier ones wrote.
test.describe.configure({ mode: "serial" });

test("happy path: password then correct code reaches the dashboard shell", async ({ page }) => {
  test.setTimeout(30000);

  await page.goto("/signin");
  await page.locator("#email").fill("ops@stablepass.co");
  await page.locator("#password").fill("correcthorse");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.waitForURL("http://127.0.0.1:3002/signin/mfa", { timeout: 30000 });
  await expect(page.locator(".admin-signin-card")).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole("heading", { name: "Enter your code." })).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/11-signin-mfa.png" });

  await page.locator("#code").fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();

  await page.waitForURL("http://127.0.0.1:3002/", { timeout: 30000 });
  await expect(page.locator(".admin-shell")).toBeVisible({ timeout: 30000 });
});

test("wrong code keeps the admin on /signin/mfa to retry", async ({ page }) => {
  test.setTimeout(30000);

  await page.goto("/signin");
  await page.locator("#email").fill("ops@stablepass.co");
  await page.locator("#password").fill("correcthorse");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.waitForURL("http://127.0.0.1:3002/signin/mfa", { timeout: 30000 });
  await page.locator("#code").fill("000000");
  await page.getByRole("button", { name: "Verify" }).click();

  // A mistyped digit must not cost the whole sign-in: stay on the challenge
  // screen, keep the AAL1 session, and show the code field again.
  await expect(page.getByRole("alert")).toContainText("didn't match", { timeout: 30000 });
  expect(page.url()).toContain("/signin/mfa");
  await expect(page.locator("#code")).toBeVisible();
  await page.screenshot({ path: "e2e/__screenshots__/12-signin-mfa-error.png" });
});

test("running out of attempts drops the session back to /signin", async ({ page }) => {
  test.setTimeout(60000);

  await page.goto("/signin");
  await page.locator("#email").fill("ops@stablepass.co");
  await page.locator("#password").fill("correcthorse");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("http://127.0.0.1:3002/signin/mfa", { timeout: 30000 });

  // Five misses exhausts the retry budget; the fifth signs out generically.
  for (let i = 0; i < 5; i++) {
    await page.locator("#code").fill("000000");
    await page.getByRole("button", { name: "Verify" }).click();
    if (i < 4) await expect(page.getByRole("alert")).toContainText("left", { timeout: 30000 });
  }

  await page.waitForURL(/\/signin(\?|$)/, { timeout: 30000 });
  expect(page.url()).not.toContain("/signin/mfa");
  await expect(page.getByText("Wrong email, password or code.")).toBeVisible({ timeout: 30000 });
});

test("audit log: a full sign-in writes signin_ok then mfa_ok", async ({ browser }) => {
  test.setTimeout(60000);
  const context = await browser.newContext();
  const page = await context.newPage();

  // Self-contained: clear first and assert on THIS flow's delta, rather than on
  // a global log that every other spec's sign-in also writes to.
  await page.request.delete("http://127.0.0.1:8787/__audit");

  await page.goto("/signin");
  await page.locator("#email").fill("ops@stablepass.co");
  await page.locator("#password").fill("correcthorse");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("**/signin/mfa", { timeout: 30000 });
  await page.locator("#code").fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL("http://127.0.0.1:3002/", { timeout: 30000 });

  const res = await page.request.get("http://127.0.0.1:8787/__audit");
  const events = (await res.json()) as Array<Record<string, unknown>>;

  // Exactly these two events, in this order, from the authenticated RPC.
  expect(
    events
      .filter((e) => e.fn === "log_admin_auth_event")
      .map((e) => e.p_event),
  ).toEqual(["signin_ok", "mfa_ok"]);

  await context.close();
});

test("failed password writes the anon log_admin_signin_fail RPC, not signin_fail via the general RPC", async ({
  browser,
}) => {
  test.setTimeout(30000);
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.request.delete("http://127.0.0.1:8787/__audit");

  await page.goto("/signin");
  await page.locator("#email").fill("ops@stablepass.co");
  await page.locator("#password").fill("wrongpassword");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByText("Wrong email or password.")).toBeVisible({ timeout: 30000 });

  const res = await page.request.get("http://127.0.0.1:8787/__audit");
  const events = (await res.json()) as Array<Record<string, unknown>>;

  expect(events.some((e) => e.fn === "log_admin_signin_fail")).toBe(true);
  expect(
    events.some((e) => e.fn === "log_admin_auth_event" && e.p_event === "signin_fail"),
  ).toBe(false);

  await context.close();
});

test("no session at /signin/mfa redirects to /signin", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("/signin/mfa");
  await page.waitForURL(/\/signin$/, { timeout: 30000 });
  expect(page.url()).toContain("/signin");
  expect(page.url()).not.toContain("/signin/mfa");

  await context.close();
});
