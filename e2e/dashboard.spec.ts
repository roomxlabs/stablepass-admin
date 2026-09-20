import { test, expect, type Page } from "@playwright/test";

// Dashboard screenshot proof (ENG-174 / T4). Backed by the mock Supabase server
// in e2e/global-setup.ts, extended with the dashboard tables (post / reaction /
// bookmark / subscription / race). Serial: signs in on its own fresh context.
test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.locator("#email").fill("ops@stablepass.co");
  await page.locator("#password").fill("correcthorse");
  await page.getByRole("button", { name: "Continue" }).click();
  // ENG-370: sign-in is two steps now — the password step lands on the TOTP
  // challenge, and only a verified code reaches "/" (which requires aal2).
  await page.waitForURL("**/signin/mfa", { timeout: 30000 });
  await page.locator("#code").fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();
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

// ENG-1269 — AC3's dashboard half. The mock seeds two HORSE-LESS published
// posts (dp8 trainer, dp9 StablePass), which is the case that used to render
// "— / —" in the old Horse + Trainer column pair and would render the literal
// "undefined" if the page read `horse.racing_name` off a null embed. This
// asserts the page renders, names both by subject, and prints neither
// "undefined" nor "null" anywhere in the table.
test("ENG-1269: the recently-published table names a horse-less post by its subject", async ({
  page,
}) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/");

  const table = page.locator(".adm-table tbody");
  await expect(table.locator("tr").first()).toBeVisible({ timeout: 30000 });

  // StablePass: the brand handle over its byline.
  const stablepassRow = table.locator("tr", { hasText: "Season wrap from the newsroom" });
  await expect(stablepassRow).toContainText("stablepass · Racing TV");

  // Trainer: the trainer's name, marked as a trainer post rather than passing
  // for a horse whose name happens to be a person's.
  const trainerRow = table.locator("tr", { hasText: "Preparing for a big Saturday" });
  await expect(trainerRow).toContainText("Peter Moody · Trainer");

  // A horse post is unchanged: the horse name with its trainer underneath.
  const horseRow = table.locator("tr", { hasText: "Last fast gallop before Saturday" });
  await expect(horseRow).toContainText("MAHOGANY (AUS)");
  await expect(horseRow).toContainText("Chris Waller");

  const body = (await table.innerText()).toLowerCase();
  expect(body).not.toContain("undefined");
  expect(body).not.toContain("null");
});
