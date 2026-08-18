import { test, expect, type Page } from "@playwright/test";

// Horses DB screenshot proofs (ENG-178). Backed by the mock Supabase server in
// e2e/global-setup.ts. Serial: each test signs in on its own fresh context.
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

  // The named fixture set is 9 horses (not the 24 trainer-roster stubs), and
  // the filter chips derive their counts from the same rows.
  await expect(page.locator(".horse-card-adm")).toHaveCount(9);
  await expect(page.getByText("Verry Elleegant")).toBeVisible();
  await expect(page.getByText("Black Caviar")).toBeVisible();
  await expect(page.getByText("Winx")).toBeVisible();

  // ENG-616: the meta line is now sourced from the database's computed columns,
  // not from a TypeScript formula. Assert the SHAPE it produces, per case.
  //
  // A gelding reads "gelding" at any age.
  await expect(first.locator(".meta")).toHaveText(/^by Chris Waller · \d+yo gelding$/);
  // A retired horse drops the age entirely and shows the training status —
  // that comes from training_status, which the DB derivation does NOT cover.
  await expect(page.locator(".horse-card-adm", { hasText: "Winx" }).locator(".meta")).toHaveText(
    "by Chris Waller · retired",
  );
  // No foaling year and no sex on record: no age, and no invented description.
  await expect(page.locator(".horse-card-adm", { hasText: "Barrier Trial" }).locator(".meta")).toHaveText(
    "by James Cummings",
  );
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

  // ENG-616: two options, nothing preselected, and a Gelded checkbox that is
  // inert until Male is chosen.
  const sex = page.locator("#horse-sex");
  await expect(sex.locator("option:not([disabled])")).toHaveCount(2);
  await expect(sex.locator("option:not([disabled])")).toHaveText(["Male", "Female"]);
  await expect(sex).toHaveValue("");
  await expect(page.locator("#horse-gelded")).toBeDisabled();

  await page.screenshot({ path: "e2e/__screenshots__/07-add-horse.png", fullPage: true });

  // Male enables it; Female clears AND disables it again.
  await sex.selectOption("male");
  await expect(page.locator("#horse-gelded")).toBeEnabled();
  await page.locator("#horse-gelded").check();
  await expect(page.locator("#horse-gelded")).toBeChecked();
  await sex.selectOption("female");
  await expect(page.locator("#horse-gelded")).not.toBeChecked();
  await expect(page.locator("#horse-gelded")).toBeDisabled();
});

test("edit horse form — an existing gelding prefills Male + Gelded", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/horses/h1/edit");
  await expect(page.getByRole("button", { name: "Save changes" }).first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#horse-sex")).toHaveValue("male");
  await expect(page.locator("#horse-gelded")).toBeChecked();
  await page.screenshot({ path: "e2e/__screenshots__/08-edit-horse.png", fullPage: true });
});

test("edit horse form — a NULL-sex row prefills neither", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/horses/h9/edit");
  await expect(page.getByRole("button", { name: "Save changes" }).first()).toBeVisible({ timeout: 30000 });
  // Never defaulted to Male: guessing a sex is exactly what this epic removed.
  await expect(page.locator("#horse-sex")).toHaveValue("");
  await expect(page.locator("#horse-gelded")).not.toBeChecked();
  await expect(page.locator("#horse-gelded")).toBeDisabled();
});
