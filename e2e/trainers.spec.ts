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
  // t1 is seeded marketing_visible in the mock, so this asserts the EDIT PAGE
  // actually seeds the checkbox rather than tolerating either state.
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
  await expect(cb).toBeChecked(); // seeded on from the mock…
  await cb.uncheck();               // …then turned off for this capture.
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
  expect(badgeCount).toBe(2);
  await page.screenshot({ path: "e2e/__screenshots__/20-trainers-on-site-badge.png", fullPage: true });
});

// ENG-746 — the Website field and the honest slug-collision message.

test("website field seeds from the trainer row", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await page.goto("/trainers/t1/edit");
  await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });

  // t1 is the only fixture carrying a website_url, so a passing assertion here
  // proves the whole seeding path: the edit page selected the column, data.ts
  // mapped it, and the form rendered it. A form that merely renders an empty
  // Website input would fail this.
  const website = page.getByTestId("trainer-website");
  await expect(website).toHaveValue("https://wallerracing.com.au");

  await website.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "e2e/__screenshots__/22-trainer-website-seeded.png", fullPage: true });
});

test("website field is empty for a trainer without one", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await page.goto("/trainers/t2/edit");
  await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });
  // t2 has no website_url. This is the other half of the seeding proof: a form
  // that hardcoded the value, or a mapper that fell back to some default, would
  // fail here even though the test above passed.
  await expect(page.getByTestId("trainer-website")).toHaveValue("");
});

test("slug collision shows the honest message", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);

  // The 409 is injected at the BFF boundary rather than in mock-supabase.mjs on
  // purpose. This POST is issued by the browser, so page.route can intercept it
  // (unlike the server-side Supabase calls, which never pass through Playwright),
  // and it keeps the order-sensitive /rest/v1 dispatcher untouched. The body is
  // the real envelope shape from lib/api/envelope.ts.
  await page.route("**/api/admin/trainers", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "slug_taken", message: "A trainer with that slug already exists." },
          }),
        })
      : route.continue(),
  );

  await page.goto("/trainers/new");
  await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });
  await page.getByTestId("trainer-name").fill("Chris Waller");
  await page.getByTestId("submit-trainer").click();

  const alert = page.locator(".form-err");
  await expect(alert).toBeVisible({ timeout: 30000 });
  // The three things the ticket requires the copy to carry: the real cause, the
  // safe fix first, and the rename second.
  await expect(alert).toContainText("/chris-waller");
  await expect(alert).toContainText("Trainers list");
  await expect(alert).toContainText("change the full name slightly");

  await page.screenshot({ path: "e2e/__screenshots__/23-trainer-slug-collision.png", fullPage: true });
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
  // t1 is seeded marketing_visible in the mock, so this asserts the EDIT PAGE
  // actually seeds the checkbox rather than tolerating either state.
  await expect(cb).toBeChecked();

  await page.getByTestId("submit-trainer").click();
  await expect(page.getByTestId("marketing-photo-warning")).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/21-trainer-marketing-copy-failed.png", fullPage: true });
});
