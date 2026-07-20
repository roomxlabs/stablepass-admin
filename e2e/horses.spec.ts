import { test, expect, type Page } from "@playwright/test";

// Horses DB screenshot proofs (ENG-178). Backed by the mock Supabase server in
// e2e/global-setup.ts. Serial: each test signs in on its own fresh context.
test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.locator("#email").fill("ops@stablepass.co");
  await page.locator("#password").fill("correcthorse");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("http://127.0.0.1:3002/", { timeout: 30000 });
}

test("horses list — populated", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/horses");
  await expect(page.locator(".horse-card-adm").first()).toBeVisible({ timeout: 30000 });

  // Assert CARD CONTENT, not just that a card exists. Visibility alone passed
  // against a grid of 24 empty cards for the whole of ENG-178 → ENG-285: the
  // mock was serving bare `{ trainer_id }` stubs and nothing noticed. These
  // assertions fail if the horse reads ever fall back to stub rows again.
  const first = page.locator(".horse-card-adm").first();
  await expect(first).toContainText("Mahogany");
  await expect(first).toContainText("Chris Waller");
  // Real follower/post counts, not the `0 followers · 0 posts` of a stub row.
  await expect(first).not.toContainText("Unassigned trainer");
  await expect(first).not.toContainText("0 followers");

  // The named fixture set is 8 horses (not the 24 trainer-roster stubs), and
  // the filter chips derive their counts from the same rows.
  await expect(page.locator(".horse-card-adm")).toHaveCount(8);
  await expect(page.getByText("Verry Elleegant")).toBeVisible();
  await expect(page.getByText("Black Caviar")).toBeVisible();
  await expect(page.getByText("Winx")).toBeVisible();

  await page.screenshot({ path: "e2e/__screenshots__/05-horses-list.png", fullPage: true });
});

test("horses list — empty", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/horses?q=__none__");
  await expect(page.locator(".horse-empty")).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/05-horses-empty.png", fullPage: true });
});

test("add horse form", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/horses/new");
  await expect(page.getByRole("button", { name: "Add to library" }).first()).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/07-add-horse.png", fullPage: true });
});

test("edit horse form", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/horses/h1/edit");
  await expect(page.getByRole("button", { name: "Save changes" }).first()).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/08-edit-horse.png", fullPage: true });
});
