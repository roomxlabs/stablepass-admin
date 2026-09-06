import { test, expect, type Page } from "@playwright/test";

// Posts library screenshot proofs (ENG-177 / T7). Backed by the mock Supabase
// server in e2e/mock-supabase.mjs (post fixtures + count header). Serial: each
// test signs in on its own fresh context.
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

test("posts library — populated", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/posts");
  await expect(page.locator(".adm-table tbody tr").first()).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/04-posts-list.png", fullPage: true });
});

// ENG-979 — the row's NAME. This is the whole of Mel's complaint, and a
// screenshot alone would not prove it: the shot shows text, not which column it
// came from. These assert the three states the fixtures seed.
test("ENG-979: the list shows the label, and 'Untitled post' only when truly unnamed", async ({
  page,
}) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/posts");
  await expect(page.locator(".adm-table tbody tr").first()).toBeVisible({ timeout: 30000 });

  const table = page.locator(".adm-table tbody");

  // 1. A labelled post is named by its LABEL, not its old title. p1 carries
  //    label "Trackwork" AND title "Last fast gallop before Saturday".
  await expect(table.getByText("Trackwork", { exact: true })).toBeVisible();
  await expect(table.getByText("Last fast gallop before Saturday")).toHaveCount(0);

  // 2. A runtime-added label renders like any other (p2 → "Owner Update"),
  //    which is what proves the list is not pinned to the preset array.
  await expect(table.getByText("Owner Update", { exact: true })).toBeVisible();

  // 3. The UN-BACKFILLED case (p4): a typed title, no label. It keeps showing
  //    its title rather than regressing to "Untitled post". These are Mel's
  //    live posts; see the PR body — nothing was backfilled.
  await expect(table.getByText("Routine day — barrier trial complete")).toBeVisible();

  // 4. "Untitled post" survives for exactly one row (p5), which has neither a
  //    label nor a title. Counting is what stops this passing because the
  //    string happens to appear somewhere.
  await expect(table.getByText("Untitled post", { exact: true })).toHaveCount(1);

  await page.screenshot({ path: "e2e/__screenshots__/26-posts-labelled.png", fullPage: true });
});

test("posts library — empty", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/posts?q=__none__");
  await expect(page.locator(".posts-empty")).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/04-posts-empty.png", fullPage: true });
});
