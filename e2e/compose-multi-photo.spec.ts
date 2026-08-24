import { test, expect, type Page } from "@playwright/test";

// ENG-748 — multi-photo compose: the strip, the up/down reorder, and the
// preview carousel.
//
// The photos are generated as BIG NUMBERED TILES rather than 1x1 placeholders,
// because the thing this ticket has to prove is ORDER. A screenshot of three
// identical grey squares cannot show that "move up" moved anything, and cannot
// show that the Cover badge followed — which is the whole compatibility seam
// (post.media_url mirrors display position 0).
test.describe.configure({ mode: "serial" });

const PHOTO_COUNT = 3;

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

/**
 * N distinct 1200x750 PNGs, each a solid brand-ish colour carrying its own huge
 * ordinal. Drawn in-page (no ffmpeg / no fixtures on disk, and no real client
 * imagery in a PR screenshot — the same rule compose.spec.ts's synthetic webm
 * follows).
 */
async function numberedPhotos(page: Page, n: number): Promise<Buffer[]> {
  const arrays = await page.evaluate(async (count) => {
    const colours = ["#285D50", "#8C5A2B", "#3A5A78", "#6B4C7A", "#7A5C2E"];
    const out: number[][] = [];
    for (let i = 0; i < count; i++) {
      const canvas = document.createElement("canvas");
      canvas.width = 1200;
      canvas.height = 750;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = colours[i % colours.length];
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#FAF7F2";
      ctx.font = "bold 420px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), canvas.width / 2, canvas.height / 2);
      const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), "image/png"));
      out.push([...new Uint8Array(await blob.arrayBuffer())]);
    }
    return out;
  }, n);
  return arrays.map((a) => Buffer.from(a));
}

/**
 * Mock the create-draft BFF call so it returns ONE upload target per slot, the
 * shape ENG-748 added, plus the browser's direct PUT to each of them.
 */
async function mockMultiUpload(page: Page, count: number) {
  await page.route("**/api/admin/posts", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const uploads = Array.from({ length: count }, (_, slot) => {
      const object = slot === 0 ? "p-e2e/original" : `p-e2e/photo-${slot}`;
      return {
        sortOrder: slot,
        path: object,
        token: "e2e",
        uploadUrl: `http://127.0.0.1:8787/storage/v1/object/upload/sign/post-media/${object}?token=e2e`,
        bucket: "post-media",
      };
    });
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          id: "p-e2e",
          status: "draft",
          type: "photo",
          watermarked: false,
          // Slot 0 stays at the top level — the back-compat shape.
          uploadUrl: uploads[0].uploadUrl,
          path: uploads[0].path,
          token: uploads[0].token,
          bucket: "post-media",
          uploads,
        },
      }),
    });
  });

  await page.route("**/storage/v1/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ Key: "post-media/p-e2e/original" }),
    }),
  );
}

// Clicks the OPTION CARD, not the inner radio — matching compose.spec.ts. The
// radio itself sits under the sticky .admin-topbar at this scroll position and
// the click is intercepted; the card is the real target anyway.
async function chooseType(page: Page, type: string) {
  await page.getByTestId(`type-option-${type}`).click();
  await expect(page.getByTestId(`type-option-${type}`)).toHaveAttribute("data-selected", "true");
}

/** Wait for the rail preview's image to actually decode before shooting. */
async function settle(page: Page, where: "rail" | "modal" = "rail") {
  const scope = where === "modal" ? '[data-testid="preview-panel"] ' : "";
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      const img = el?.querySelector("img");
      return !!img && img.complete && img.naturalWidth > 0;
    },
    `${scope}[data-testid="preview-media"]`,
    { timeout: 20000 },
  );
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );
}

/**
 * Scroll to the very top and let two frames pass before a `fullPage` shot.
 *
 * The sidebar and topbar are `position: fixed`. Playwright's fullPage capture
 * stitches the page while those stay pinned to the VIEWPORT, so a shot taken
 * after scrolling down to click something paints them partway down the image,
 * overlapping the content, with a blank gutter above. That is what corrupted
 * the first cut of 25-compose-multi-reorder.png — the ticket's single most
 * important piece of visual evidence. Caught in review by reading the pixels.
 */
async function topOfPage(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );
}

/** The ordinal painted on the tile at each strip position, via its thumbnail. */
async function stripSrcs(page: Page): Promise<string[]> {
  return page.locator('[data-testid^="photo-tile-"] img').evaluateAll((imgs) =>
    imgs.map((i) => (i as HTMLImageElement).src),
  );
}

test("compose: three photos upload, reorder, and preview as a carousel", async ({ page }) => {
  test.setTimeout(120000);
  await signIn(page);
  await mockMultiUpload(page, PHOTO_COUNT);

  await page.goto("/compose");
  await expect(page.getByRole("heading", { name: "Compose post" })).toBeVisible();

  await page.getByTestId("horse-search").fill("Mah");
  await page.getByTestId("horse-opt-h1").click();
  await expect(page.getByTestId("byline-select")).toHaveValue("t1");
  await page
    .getByTestId("caption")
    .fill("Three from this morning's gallop — the last one is the pick of them.");

  await chooseType(page, "photo");

  // The input must actually offer multi-select for a photo post.
  await expect(page.getByTestId("media-input")).toHaveAttribute("multiple", "");

  const photos = await numberedPhotos(page, PHOTO_COUNT);
  await page.getByTestId("media-input").setInputFiles(
    photos.map((buffer, i) => ({
      name: `gallop-${i + 1}.png`,
      mimeType: "image/png",
      buffer,
    })),
  );

  // All three tiles present and settled, cover on the first.
  await expect(page.getByTestId("photo-strip")).toBeVisible();
  await expect(page.locator('[data-testid^="photo-tile-"]')).toHaveCount(PHOTO_COUNT);
  await expect(page.getByTestId("upload-done")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("photo-cover")).toHaveCount(1);
  await expect(page.getByTestId("photo-tile-0").getByTestId("photo-cover")).toBeVisible();
  await expect(page.getByTestId("photo-strip-help")).toContainText("3 of 10 photos");
  await settle(page);

  // EVIDENCE 1 — the multi-upload: three numbered tiles, 1 is the cover.
  await topOfPage(page);
  await page.screenshot({
    path: "e2e/__screenshots__/24-compose-multi-upload.png",
    fullPage: true,
  });

  const before = await stripSrcs(page);

  // EVIDENCE 2 — the reorder. Bring photo 3 to the very front with two "up"
  // clicks, which is exactly what an operator does.
  await page.getByTestId("photo-up-2").click();
  await page.getByTestId("photo-up-1").click();

  const after = await stripSrcs(page);
  // Display order really moved: what was last is now first.
  expect(after[0]).toBe(before[2]);
  expect(after[1]).toBe(before[0]);
  expect(after[2]).toBe(before[1]);

  // THE SEAM: the Cover badge — post.media_url's stand-in — followed the move.
  await expect(page.getByTestId("photo-cover")).toHaveCount(1);
  await expect(page.getByTestId("photo-tile-0").getByTestId("photo-cover")).toBeVisible();
  // And the first tile is no longer photo 1.
  await expect(page.getByTestId("photo-tile-0").locator("img")).toHaveJSProperty(
    "src",
    before[2],
  );
  await settle(page);

  await topOfPage(page);
  await page.screenshot({
    path: "e2e/__screenshots__/25-compose-multi-reorder.png",
    fullPage: true,
  });

  // EVIDENCE 3 — the preview carousel: dots + count, opening on the new cover.
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.getByRole("button", { name: "Preview post" }).click();
  await expect(page.getByTestId("preview-modal")).toBeVisible();
  await settle(page, "modal");

  const panel = page.getByTestId("preview-panel");
  await expect(panel.getByTestId("preview-dots")).toBeVisible();
  await expect(panel.locator('[data-testid^="preview-dot-"]')).toHaveCount(PHOTO_COUNT);
  await expect(panel.getByTestId("preview-count")).toHaveText("1/3");

  await panel.screenshot({ path: "e2e/__screenshots__/26-compose-carousel.png" });

  // Paging works and the count tracks it.
  await panel.getByTestId("preview-dot-2").click();
  await expect(panel.getByTestId("preview-count")).toHaveText("3/3");
  await settle(page, "modal");
  await panel.screenshot({ path: "e2e/__screenshots__/27-compose-carousel-paged.png" });
});

test("compose: a single photo gets no carousel — 1 and 0 render alike", async ({ page }) => {
  test.setTimeout(120000);
  await signIn(page);
  await mockMultiUpload(page, 1);

  await page.goto("/compose");
  await page.getByTestId("horse-search").fill("Mah");
  await page.getByTestId("horse-opt-h1").click();
  await page.getByTestId("caption").fill("One from this morning.");
  await chooseType(page, "photo");

  const [only] = await numberedPhotos(page, 1);
  await page
    .getByTestId("media-input")
    .setInputFiles({ name: "gallop-1.png", mimeType: "image/png", buffer: only });

  await expect(page.getByTestId("upload-done")).toBeVisible({ timeout: 20000 });
  await settle(page);

  // The strip still appears (it is where the state and the controls live), but
  // there is no pager anywhere — ENG-740's rule that a post with one photo and
  // a post with zero post_media rows must render identically.
  await expect(page.locator('[data-testid^="photo-tile-"]')).toHaveCount(1);
  await expect(page.getByTestId("preview-dots")).toHaveCount(0);
  await expect(page.getByTestId("preview-count")).toHaveCount(0);
  // Both reorder directions are dead ends for a single photo.
  await expect(page.getByTestId("photo-up-0")).toBeDisabled();
  await expect(page.getByTestId("photo-down-0")).toBeDisabled();

  await topOfPage(page);
  await page.screenshot({
    path: "e2e/__screenshots__/28-compose-single-photo.png",
    fullPage: true,
  });
});
