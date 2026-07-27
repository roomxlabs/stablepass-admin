import { test, expect } from "@playwright/test";

// Forced TOTP enrolment (ENG-371) — /signin/mfa-setup.
//
// SCOPE OF THIS SPEC, AND WHY IT STOPS WHERE IT DOES.
// The shared mock (e2e/mock-supabase.mjs, A1/ENG-370's surface) implements the
// CHALLENGE half of the MFA API — POST /auth/v1/factors/:id/challenge and
// /verify — but not the ENROL half: there is no POST /auth/v1/factors and no
// DELETE /auth/v1/factors/:id, and its ADMIN_USER always carries a *verified*
// factor, so no session it can mint ever reaches the "nothing enrolled" state
// this screen is for. Unknown routes fall through to `200 {}` rather than 404,
// so an enrol attempt against it yields a body with no `totp` — the page's
// recoverable-error branch, not a QR.
//
// Rather than edit another ticket's file, this spec asserts everything that IS
// reachable: the three redirect branches of the inline gate. Those are the
// security-relevant ones — they prove nobody who shouldn't be here is shown a
// QR, and that an admin who lands here is never bounced in a loop. The QR
// render itself is covered by app/signin/mfa-setup/page.test.ts and by the
// screenshot on the PR (captured against a throwaway mock that does implement
// enrol). See the PR body.
test.describe.configure({ mode: "serial" });

test("no session at /signin/mfa-setup redirects to /signin, showing no QR", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("/signin/mfa-setup");
  await page.waitForURL(/\/signin$/, { timeout: 30000 });
  expect(page.url()).not.toContain("/signin/mfa-setup");
  await expect(page.getByRole("heading", { name: "Sign in." })).toBeVisible({ timeout: 30000 });
  await expect(page.locator("code")).toHaveCount(0);

  await context.close();
});

test("an AAL1 admin who already has a verified factor is sent to the challenge, not re-enrolled", async ({
  page,
}) => {
  test.setTimeout(60000);

  // Password step only — this leaves the session at aal1 with the mock's
  // pre-existing verified factor.
  await page.goto("/signin");
  await page.locator("#email").fill("ops@stablepass.co");
  await page.locator("#password").fill("correcthorse");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("**/signin/mfa", { timeout: 30000 });

  await page.goto("/signin/mfa-setup");
  await page.waitForURL("**/signin/mfa", { timeout: 30000 });
  await expect(page.getByRole("heading", { name: "Enter your code." })).toBeVisible({
    timeout: 30000,
  });
  // Critically: it did NOT stay on mfa-setup and did NOT mint a second factor.
  expect(page.url()).not.toContain("mfa-setup");
});

test("a fully signed-in aal2 admin is sent to the dashboard", async ({ page }) => {
  test.setTimeout(60000);

  await page.goto("/signin");
  await page.locator("#email").fill("ops@stablepass.co");
  await page.locator("#password").fill("correcthorse");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("**/signin/mfa", { timeout: 30000 });
  await page.locator("#code").fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL("http://127.0.0.1:3002/", { timeout: 30000 });

  await page.goto("/signin/mfa-setup");
  await page.waitForURL("http://127.0.0.1:3002/", { timeout: 30000 });
  await expect(page.locator(".admin-shell")).toBeVisible({ timeout: 30000 });
});
