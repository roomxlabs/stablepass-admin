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
  await page.getByRole("button", { name: "Continue" }).click();
  // ENG-370: sign-in is two steps now — the password step lands on the TOTP
  // challenge, and only a verified code reaches "/" (which requires aal2).
  await page.waitForURL("**/signin/mfa", { timeout: 30000 });
  await page.locator("#code").fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();
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

// ENG-766 — marketing-visibility screenshots.

test("marketing toggle ON", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await page.goto("/trainers/t1/edit");
  await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });
  const cb = page.getByTestId("marketing-visible");
  if (!(await cb.isChecked())) await cb.check();
  await expect(cb).toBeChecked();
  // getByText() is a case-insensitive substring match, so the bare string also
  // matches the checkbox's own "Show on marketing site" label — scope to the
  // card heading.
  await page.getByRole("heading", { name: "Marketing site" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "e2e/__screenshots__/18-trainer-marketing-on.png", fullPage: true });
});

test("marketing toggle OFF", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await page.goto("/trainers/t1/edit");
  await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });
  const cb = page.getByTestId("marketing-visible");
  if (await cb.isChecked()) await cb.uncheck();
  await expect(cb).not.toBeChecked();
  await page.getByRole("heading", { name: "Marketing site" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "e2e/__screenshots__/19-trainer-marketing-off.png", fullPage: true });
});

test("trainers list On site badge", async ({ page }) => {
  test.setTimeout(90000);
  await setEmpty(false);
  await signIn(page);
  await page.goto("/trainers");
  await expect(page.getByTestId("trainers-table")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("on-site-badge").first()).toBeVisible();
  const badgeCount = await page.getByTestId("on-site-badge").count();
  expect(badgeCount).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: "e2e/__screenshots__/20-trainers-on-site-badge.png", fullPage: true });
});

test("failed photo copy warning", async ({ page }) => {
  test.setTimeout(90000);

  // 1x1 transparent PNG bytes.
  // A 480x480 neutral stone-toned image. Deliberately not a 1x1 pixel: the
  // preview box is 260px tall with object-fit: cover, so a single pixel stretches
  // into a flat block that reads as a rendering fault in the screenshot evidence.
  const PNG = Buffer.from(
    "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",
    "base64",
  );

  // The signed-URL mint for the private bucket -> succeed.
  await page.route("**/storage/v1/object/sign/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ signedURL: "/storage/v1/object/fake-signed.png" }),
    }),
  );
  // The actual signed download -> succeed, return a real PNG.
  await page.route("**/fake-signed.png**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG }),
  );
  // Uploads INTO the public marketing bucket -> FAIL (this is what we are proving).
  await page.route("**/storage/v1/object/marketing-photos/**", (route) => route.abort());
  // Uploads into the private trainer bucket (the form's own photo upload) -> succeed.
  await page.route("**/storage/v1/object/trainer-photos/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ Key: "trainer-photos/x.jpg" }),
    }),
  );

  await signIn(page);
  await page.goto("/trainers/t1/edit");
  await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });

  // Attach a photo so there is something to copy.
  await page.locator("input[type=file]").setInputFiles({
    name: "waller.jpg",
    mimeType: "image/jpeg",
    buffer: PNG,
  });
  await expect(page.getByText("Photo added")).toBeVisible({ timeout: 15000 });

  const cb = page.getByTestId("marketing-visible");
  if (!(await cb.isChecked())) await cb.check();

  await page.getByTestId("submit-trainer").click();
  await expect(page.getByTestId("marketing-photo-warning")).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/21-trainer-marketing-copy-failed.png", fullPage: true });
});
