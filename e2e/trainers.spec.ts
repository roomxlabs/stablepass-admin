import { test, expect, type Page } from "@playwright/test";

// Trainers screenshot proofs (ENG-179), backed by the mock Supabase server.
// The mock's /__control endpoint flips the dataset between populated and empty
// so we can capture both list states plus the add-trainer form.
test.describe.configure({ mode: "serial" });

const CONTROL = "http://127.0.0.1:8787/__control";
async function setEmpty(empty: boolean) {
  await fetch(CONTROL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ empty }),
  });
}

async function signIn(page: Page) {
  await page.goto("/signin");
  await page.locator("#email").fill("ops@stablepass.co");
  await page.locator("#password").fill("correcthorse");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("http://127.0.0.1:3002/", { timeout: 30000 });
}

test("trainers list renders populated (06-trainers)", async ({ page }) => {
  test.setTimeout(60000);
  await setEmpty(false);
  await signIn(page);
  await page.goto("/trainers");
  await expect(page.getByTestId("trainers-table")).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/06-trainers-list.png", fullPage: true });
});

test("trainers list renders the empty state", async ({ page }) => {
  test.setTimeout(60000);
  await setEmpty(true);
  await signIn(page);
  await page.goto("/trainers");
  await expect(page.getByTestId("trainers-empty")).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/06-trainers-empty.png", fullPage: true });
  await setEmpty(false);
});

test("add-trainer form renders (08-add-trainer)", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/trainers/new");
  await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/08-add-trainer.png", fullPage: true });
});
