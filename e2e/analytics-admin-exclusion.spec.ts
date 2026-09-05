import { test, expect, type Page } from "@playwright/test";

// ENG-984 — before/after proof that analytics excludes operator activity.
//
// Justin, on the analytics page: "Can we have it that it doesn't include us?"
// These two screenshots are that question answered. BOTH runs use the SAME
// seeded engagement rows (a mix of operator and member activity); the only
// difference is whether the mock reports the operator account as
// `app_user.is_admin = true`.
//
// That is deliberately the cleanest possible A/B: identical data, identical
// code path, and the ONLY variable is whether staff are recognised as staff. It
// isolates the exclusion itself, rather than confounding it with a change of
// data source or a change of build.
//
// Seeded/fake data only — no production rows, no member PII (the analytics
// screen renders aggregates and horse/trainer names, never a member identity).
test.describe.configure({ mode: "serial" });

const CONTROL = "http://127.0.0.1:8787/__control";

// `excludeAdmin: false` makes the mock report NO admin accounts, so the shared
// helper's exclusion set is empty and every operator row is counted — i.e. the
// behaviour the client was looking at when he asked the question.
async function setExcludeAdmin(excludeAdmin: boolean) {
  const r = await fetch(CONTROL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ empty: false, excludeAdmin }),
  });
  expect(r.ok).toBe(true);
}

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

// Reads the four engagement tiles so the two runs can be compared as NUMBERS
// and not just as two pictures a reviewer has to eyeball.
async function tileNumbers(page: Page): Promise<string> {
  const tiles = page.getByTestId("analytics-tiles");
  await expect(tiles).toBeVisible({ timeout: 30000 });
  return (await tiles.innerText()).replace(/\s+/g, " ").trim();
}

let includingAdmins = "";
let excludingAdmins = "";

test("BEFORE — analytics counts operator activity (16-analytics-including-admins)", async ({
  page,
}) => {
  test.setTimeout(90000);
  await setExcludeAdmin(false);
  await signIn(page);
  await page.goto("/analytics");
  includingAdmins = await tileNumbers(page);
  await expect(page.getByTestId("trainer-engagement")).toBeVisible();
  await page.screenshot({
    path: "e2e/__screenshots__/16-analytics-including-admins.png",
    fullPage: true,
  });
});

test("AFTER — the same data with operator activity excluded (16-analytics-excluding-admins)", async ({
  page,
}) => {
  test.setTimeout(90000);
  await setExcludeAdmin(true);
  await signIn(page);
  await page.goto("/analytics");
  excludingAdmins = await tileNumbers(page);
  await expect(page.getByTestId("trainer-engagement")).toBeVisible();
  await page.screenshot({
    path: "e2e/__screenshots__/16-analytics-excluding-admins.png",
    fullPage: true,
  });

  // The proof, asserted rather than left to the eye: excluding staff must
  // actually move the numbers. If these matched, the screenshots would be a
  // pair of identical pictures proving nothing.
  expect(excludingAdmins).not.toBe(includingAdmins);
});

test("per-post analytics also drops operator opens, reactions and saves", async ({ page }) => {
  test.setTimeout(90000);
  await setExcludeAdmin(false);
  await signIn(page);
  await page.goto("/analytics/posts/pa1");
  const before = await page.getByTestId("post-tiles").innerText();

  await setExcludeAdmin(true);
  await page.goto("/analytics/posts/pa1");
  const after = await page.getByTestId("post-tiles").innerText();

  expect(after).not.toBe(before);
  await page.screenshot({
    path: "e2e/__screenshots__/17-post-analytics-excluding-admins.png",
    fullPage: true,
  });
});

test.afterAll(async () => {
  // Leave the mock in its default state so the other specs are unaffected.
  await setExcludeAdmin(true);
});
