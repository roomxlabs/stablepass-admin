import { test, expect } from "@playwright/test";

// Compose screen (ENG-176 / T6) screenshot proofs, backed by the mock Supabase
// server (horse/trainer fixtures) + browser-level route mocks for the
// direct-upload flow (the real Mux/Storage targets aren't reachable in e2e).
test.describe.configure({ mode: "serial" });

// 1x1 PNG — enough for the object-URL <img> preview to render a filled zone.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/signin");
  await page.locator("#email").fill("ops@stablepass.co");
  await page.locator("#password").fill("correcthorse");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("http://127.0.0.1:3002/", { timeout: 30000 });
}

test("compose: pick horse, upload photo, caption, preview", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);

  // Mock the create-draft BFF call (photo branch) — returns a signed-upload target.
  await page.route("**/api/admin/posts", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            id: "p-e2e",
            status: "draft",
            type: "photo",
            watermarked: false,
            uploadUrl:
              "http://127.0.0.1:8787/storage/v1/object/upload/sign/post-media/p-e2e/original?token=e2e",
            path: "p-e2e/original",
            token: "e2e",
            bucket: "post-media",
          },
        }),
      });
    } else {
      await route.continue();
    }
  });
  // Mock the browser's direct PUT to Storage.
  await page.route("**/storage/v1/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ Key: "post-media/p-e2e/original" }),
    }),
  );

  await page.goto("/compose");
  await expect(page.getByRole("heading", { name: "Compose post" })).toBeVisible();
  await page.screenshot({ path: "e2e/__screenshots__/04-compose-empty.png", fullPage: true });

  // Pick horse → byline auto-fills to the horse's trainer.
  await page.getByTestId("horse-search").fill("Mah");
  await page.getByTestId("horse-opt-h1").click();
  await expect(page.getByTestId("byline-select")).toHaveValue("t1");

  // Upload a photo (straight to Storage via the signed URL).
  await page.getByTestId("media-input").setInputFiles({
    name: "gallop.jpg",
    mimeType: "image/jpeg",
    buffer: PNG_1x1,
  });
  await expect(page.getByTestId("upload-done")).toBeVisible({ timeout: 15000 });

  await page
    .getByTestId("caption")
    .fill("Last fast gallop before Saturday — he's spot-on. Came home strong over the final 200.");

  await page.screenshot({ path: "e2e/__screenshots__/05-compose-filled.png", fullPage: true });

  // Full mobile + web preview.
  await page.getByRole("button", { name: "Preview on mobile & web" }).click();
  await expect(page.getByTestId("preview-modal")).toBeVisible();
  await page.screenshot({ path: "e2e/__screenshots__/06-compose-preview.png" });
});
