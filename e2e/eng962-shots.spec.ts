import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * ENG-962 evidence capture — the 720-899px band and the compose phone overflow.
 * Not an assertion suite; it exists so the PR can show the three reference
 * widths side by side for every screen the ticket names.
 */
test.describe.configure({ mode: "serial" });

const OUT = "e2e/__screenshots__/eng962";

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

const WIDTHS = [
  { name: "390", width: 390, height: 900 },
  { name: "768", width: 768, height: 1100 },
  { name: "1280", width: 1280, height: 900 },
];

test("ENG-962 — posts / trainers / analytics at 390, 768, 1280", async ({ page }) => {
  test.setTimeout(240000);
  fs.mkdirSync(OUT, { recursive: true });
  await signIn(page);

  for (const vp of WIDTHS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const [route, label] of [
      ["/posts", "posts"],
      ["/trainers", "trainers"],
      ["/analytics", "analytics"],
    ] as const) {
      await page.goto(route);
      await expect(page.locator(".admin-content")).toBeVisible({ timeout: 30000 });
      await page.waitForTimeout(500);
      await page.screenshot({
        path: path.join(OUT, `${label}-${vp.name}.png`),
        fullPage: false,
      });
    }
  }
});

test("ENG-962 — compose at 390 with a photo picked", async ({ page }) => {
  test.setTimeout(240000);
  fs.mkdirSync(OUT, { recursive: true });
  await signIn(page);

  await page.route("**/api/admin/posts", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
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
  });
  await page.route("**/storage/v1/object/upload/sign/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ Key: "post-media/p-e2e/original" }),
    }),
  );

  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/compose");
  await expect(page.getByRole("heading", { name: "Compose post" })).toBeVisible();

  await page.getByTestId("horse-search").fill("Mah");
  await page.getByTestId("horse-opt-h1").click();
  await page.getByTestId("caption").fill("Last fast gallop before Saturday — he's spot-on.");
  await page.getByTestId("type-option-photo").click();
  // A REAL 1600x900 photo: a 1x1 placeholder reports a 1px intrinsic width and
  // so never reproduces the min-content overflow this ticket fixes.
  await page.getByTestId("media-input").setInputFiles({
    name: "gallop.png",
    mimeType: "image/png",
    buffer: fs.readFileSync("e2e/fixtures/wide-1600x900.png"),
  });
  await expect(page.getByTestId("upload-done")).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, "compose-photo-390.png"), fullPage: false });
});
