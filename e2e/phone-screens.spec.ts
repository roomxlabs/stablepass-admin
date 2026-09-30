import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

// ENG-1590 (A3b) — tables, grids and compose at phone width. ENG-1585 (A3a)
// made the SHELL fit a phone (phone-shell.spec.ts); this proves the screens
// inside it do: posts / trainers / waitlist tables become stacked cards, the
// horses grid steps down to 2 per row, and compose (every step, the upload
// progress and the poster scrubber) fits 390px. Each screen asserts CONTENT
// (names, counts, labels), not mere presence — see .rx/gotchas.md "A
// visibility-only e2e assertion proves nothing about content".
test.describe.configure({ mode: "serial" });

const PHONE = { width: 390, height: 844 };
const SHOTS = "e2e/__screenshots__/eng1590";
const DASH_SHOTS = "e2e/__screenshots__/eng1639";
// Synthetic 8s ball+timestamp clip (ENG-1584's fixture): it has a duration,
// so the poster scrubber enables. Never real client footage.
const FIXTURE = readFileSync(path.join(__dirname, "fixtures", "poster-frame.webm"));

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
 * No sideways page scroll AND nothing clipped: every visible element inside
 * the page content must end inside the viewport. The second half matters
 * because `.adm-card` is `overflow: hidden` — a too-wide table inside it
 * leaves `scrollWidth` at 390 while its right-hand columns are simply cut off
 * (that is what the horses grid did before this ticket).
 */
async function fitsPhone(page: Page, where: string) {
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const offenders: string[] = [];
    document.querySelectorAll(".admin-main *").forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) return;
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.position === "fixed") return;
      if (b.left < -1 || b.right > vw + 1) {
        offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ").join(".")} [${Math.round(b.left)}, ${Math.round(b.right)}]`);
      }
    });
    return { scroll: document.documentElement.scrollWidth, vw, offenders: offenders.slice(0, 10) };
  });
  expect(r.scroll, `horizontal page scroll on ${where}`).toBeLessThanOrEqual(r.vw);
  expect(r.offenders, `elements past the ${r.vw}px edge on ${where}`).toEqual([]);
}

async function twoFrames(page: Page) {
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );
}

test.describe("phone (390×844)", () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test("posts, trainers and waitlist are stacked cards; horses are 2 per row", async ({ page }) => {
    test.setTimeout(120000);
    await signIn(page);

    // ---- Posts ------------------------------------------------------------
    await page.goto("/posts");
    const firstPost = page.locator(".adm-table tbody tr").first();
    await expect(firstPost.locator(".row-name")).toHaveText("Trackwork", { timeout: 30000 });
    // A card, not a table row: the Post cell spans the whole card.
    // toHaveText also matches the still-hidden streamed copy (the Suspense
    // boundary swaps it in a beat later), so wait for it to be ON screen.
    await expect(firstPost).toBeVisible();
    const card = await firstPost.boundingBox();
    const postCell = await firstPost.locator("td.with-thumb").boundingBox();
    expect(postCell!.width).toBeGreaterThan(card!.width - 40);
    // The header is gone as a header, but its SORT links survive as a bar.
    await expect(page.getByTestId("th-subject").getByRole("link")).toBeVisible();
    await expect(page.locator(".adm-table thead th", { hasText: "Type" })).toBeHidden();
    // "Posted as" is captioned once its column header is gone.
    await expect(firstPost.getByTestId("post-subject")).toHaveAttribute("data-label", "Posted as");
    await expect(firstPost.getByTestId("post-subject")).toContainText("Mahogany");
    await fitsPhone(page, "/posts");
    await page.screenshot({ path: `${SHOTS}/phone-posts.png`, fullPage: true });

    // ---- Horses -----------------------------------------------------------
    await page.goto("/horses");
    const cards = page.locator(".horse-card-adm");
    await expect(cards).toHaveCount(9, { timeout: 30000 });
    await expect(cards.last()).toBeVisible({ timeout: 30000 });
    await expect(cards.first().locator(".name")).toHaveText("Mahogany");
    const tops = await cards.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(tops[0]).toBe(tops[1]); // two side by side…
    expect(tops[2]).toBeGreaterThan(tops[0]); // …then a new row
    // No card clips its own name any more (they were ~67px wide at 4-up).
    const clipped = await page.$$eval(".horse-card-adm .name", (els) =>
      els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent),
    );
    expect(clipped).toEqual([]);
    await fitsPhone(page, "/horses");
    await page.screenshot({ path: `${SHOTS}/phone-horses.png`, fullPage: true });

    // ---- Trainers ---------------------------------------------------------
    await page.goto("/trainers");
    const table = page.getByTestId("trainers-table");
    await expect(table.locator("tbody tr").first().locator(".row-name")).toHaveText("Chris Waller", {
      timeout: 30000,
    });
    await expect(table.locator("tbody tr").first().locator('td[data-label="Stable"]')).toContainText(
      "Chris Waller Racing",
    );
    await expect(table.locator("tbody tr").first().getByRole("link", { name: "Edit" })).toBeVisible();
    await fitsPhone(page, "/trainers");
    await page.screenshot({ path: `${SHOTS}/phone-trainers.png`, fullPage: true });

    // ---- Waitlist ---------------------------------------------------------
    await page.goto("/waitlist");
    await expect(page.locator(".adm-table tbody tr")).toHaveCount(25, { timeout: 30000 });
    await expect(page.locator(".adm-table tbody tr").first()).toContainText("arlo@example.com");
    // No sortable column → no sort bar; the header row is simply gone.
    await expect(page.locator(".adm-table thead")).toBeHidden();
    await expect(page.getByTestId("waitlist-export")).toBeVisible();
    await fitsPhone(page, "/waitlist");
    await page.screenshot({ path: `${SHOTS}/phone-waitlist.png`, fullPage: true });
  });

  test("compose: every step, the upload progress and the poster scrubber fit the phone", async ({
    page,
  }) => {
    test.setTimeout(150000);
    await signIn(page);

    // Hold the direct upload open so the in-flight progress row can be shot.
    let releaseUpload: () => void = () => {};
    const uploadHeld = new Promise<void>((r) => (releaseUpload = r));
    await page.route("**/api/admin/posts", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            id: "p-e2e",
            status: "draft",
            type: "video",
            watermarked: false,
            uploadUrl: "http://127.0.0.1:8787/mock-upload/p-e2e",
            muxUploadId: "up-e2e",
          },
        }),
      });
    });
    await page.route("**/mock-upload/**", async (route) => {
      await uploadHeld;
      await route.fulfill({ status: 200, body: "" });
    });

    await page.goto("/compose");
    await expect(page.getByRole("heading", { name: "Compose post" })).toBeVisible();
    await fitsPhone(page, "/compose (empty)");
    await page.screenshot({ path: `${SHOTS}/phone-compose-empty.png`, fullPage: true });

    // Step 1 · Subject
    await page.getByTestId("horse-search").fill("Mah");
    await page.getByTestId("horse-opt-h1").click();
    await expect(page.getByTestId("byline-select")).toHaveValue("t1");
    await page.getByText("Step 1 · Subject").scrollIntoViewIfNeeded();
    await fitsPhone(page, "compose step 1");
    await page.screenshot({ path: `${SHOTS}/phone-compose-step1-subject.png` });

    // Step 2 · Post type
    await page.getByTestId("type-option-video").click();
    await page.getByText("Step 2 · Post type").scrollIntoViewIfNeeded();
    await fitsPhone(page, "compose step 2");
    await page.screenshot({ path: `${SHOTS}/phone-compose-step2-type.png` });

    // Step 3 · Media — mid-upload: the progress figure must be ON screen.
    await page.getByTestId("media-input").setInputFiles({
      name: "a-rather-long-trackwork-clip-name-from-the-phone-camera.webm",
      mimeType: "video/webm",
      buffer: FIXTURE,
    });
    const status = page.getByText(/· uploading/);
    await expect(status).toBeVisible({ timeout: 20000 });
    await status.scrollIntoViewIfNeeded();
    const statusFits = await status.evaluate((el) => {
      const b = el.getBoundingClientRect();
      // The meta line used to be `nowrap` + ellipsis, which cut exactly this off.
      const meta = el.parentElement!;
      return b.right <= document.documentElement.clientWidth && meta.scrollWidth <= meta.clientWidth + 1;
    });
    expect(statusFits, "upload status is clipped").toBe(true);
    await fitsPhone(page, "compose step 3 (uploading)");
    await page.screenshot({ path: `${SHOTS}/phone-compose-step3-uploading.png` });

    releaseUpload();
    await expect(page.getByTestId("upload-done")).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("poster-use-frame")).toBeEnabled({ timeout: 20000 });

    // The scrubber is a real touch target now: ≥44px tall, full width.
    const range = page.getByTestId("poster-scrubber-range");
    const rb = await range.boundingBox();
    expect(rb!.height).toBeGreaterThanOrEqual(44);
    expect(rb!.width).toBeGreaterThan(250);
    await page.getByTestId("poster-scrubber").scrollIntoViewIfNeeded();
    await twoFrames(page);
    await fitsPhone(page, "compose step 3 (scrubber)");
    await page.screenshot({ path: `${SHOTS}/phone-compose-step3-scrubber.png` });

    // Step 4 · Words
    await page
      .getByTestId("caption")
      .fill("Last fast gallop before Saturday — he's spot-on. Came home strong over the final 200.");
    await page.getByText("Step 4 · Words").scrollIntoViewIfNeeded();
    await fitsPhone(page, "compose step 4");
    await page.screenshot({ path: `${SHOTS}/phone-compose-step4-words.png` });

    // Publish panel + the member-card preview rail (below the steps at 390).
    await page.getByTestId("primary-action").scrollIntoViewIfNeeded();
    await fitsPhone(page, "compose publish panel");
    await page.screenshot({ path: `${SHOTS}/phone-compose-publish.png` });
    await page.screenshot({ path: `${SHOTS}/phone-compose-filled-full.png`, fullPage: true });

    // Preview modal at phone width.
    await page.getByRole("button", { name: "Preview post" }).first().click();
    await expect(page.getByTestId("preview-modal")).toBeVisible();
    await twoFrames(page);
    await fitsPhone(page, "compose preview modal");
    await page.screenshot({ path: `${SHOTS}/phone-compose-preview-modal.png` });
  });

  // ENG-1639 (A3a-fix) — the dashboard itself, which ENG-1590 never covered.
  test("dashboard: tiles 2 per row, panels stacked, recently published as cards", async ({ page }) => {
    test.setTimeout(120000);
    await signIn(page); // lands on "/"

    const tiles = page.locator(".adm-stats .adm-stat");
    await expect(tiles).toHaveCount(4, { timeout: 30000 });
    await expect(tiles.nth(3).locator(".label")).toHaveText("Members");
    const tileBoxes = await tiles.evaluateAll((els) =>
      els.map((e) => {
        const b = e.getBoundingClientRect();
        return { top: Math.round(b.top), left: Math.round(b.left) };
      }),
    );
    expect(tileBoxes[0].top).toBe(tileBoxes[1].top); // two side by side…
    expect(tileBoxes[2].top).toBeGreaterThan(tileBoxes[0].top); // …then a new row
    expect(tileBoxes[2].left).toBe(tileBoxes[0].left);

    // Race day above Quiet horses, both full width — not two narrow columns.
    const panels = page.locator(".adm-grid-2 > .adm-card");
    await expect(panels.nth(0).locator("h2")).toContainText("Race day");
    await expect(panels.nth(1).locator("h2")).toContainText("Quiet horses");
    const [race, quiet] = await panels.evaluateAll((els) =>
      els.map((e) => {
        const b = e.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, left: b.left, width: b.width };
      }),
    );
    expect(quiet.top).toBeGreaterThanOrEqual(race.bottom);
    expect(quiet.left).toBe(race.left);
    expect(quiet.width).toBe(race.width);
    await expect(page.locator(".adm-race-row").first()).toContainText("MAHOGANY (AUS)");

    // Recently published: a stacked card per post, its captions on screen.
    const table = page.getByTestId("recent-posts");
    const first = table.locator("tbody tr").first();
    await expect(first).toBeVisible({ timeout: 30000 });
    expect(await table.evaluate((e) => getComputedStyle(e).display)).toBe("block");
    await expect(table.locator("thead")).toBeHidden(); // no sortable column → no sort bar
    const card = await first.boundingBox();
    const postCell = await first.locator("td.with-thumb").boundingBox();
    expect(postCell!.width).toBeGreaterThan(card!.width - 40);
    await expect(first.locator('td[data-label="Posted as"]')).toBeVisible();
    await expect(first.locator('td[data-label="Published"]')).toBeVisible();
    await expect(first).toContainText("reactions"); // ENGAGEMENT was the clipped column
    await expect(first.getByRole("link", { name: "Edit" })).toBeVisible();

    await fitsPhone(page, "/ (dashboard)");
    await page.screenshot({ path: `${DASH_SHOTS}/phone-390-dashboard.png`, fullPage: true });
  });
});

test.describe("desktop (1280×900) — unchanged", () => {
  test("tables stay tables, horses stay 6 per row", async ({ page }) => {
    test.setTimeout(120000);
    await signIn(page);

    await page.goto("/posts");
    await expect(page.locator(".adm-table tbody tr").first().locator(".row-name")).toHaveText("Trackwork", {
      timeout: 30000,
    });
    await expect(page.locator(".adm-table tbody tr").first()).toBeVisible();
    expect(await page.locator(".adm-table").evaluate((e) => getComputedStyle(e).display)).toBe("table");
    await expect(page.locator(".adm-table thead th", { hasText: "Type" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/desktop-posts.png`, fullPage: true });

    await page.goto("/horses");
    const cards = page.locator(".horse-card-adm");
    await expect(cards).toHaveCount(9, { timeout: 30000 });
    await expect(cards.last()).toBeVisible({ timeout: 30000 });
    const tops = await cards.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(tops.slice(0, 6).every((t) => t === tops[0])).toBe(true);
    expect(tops[6]).toBeGreaterThan(tops[0]);
    await page.screenshot({ path: `${SHOTS}/desktop-horses.png`, fullPage: true });

    await page.goto("/trainers");
    await expect(page.getByTestId("trainers-table").locator("thead th").first()).toBeVisible({ timeout: 30000 });
    expect(
      await page.getByTestId("trainers-table").evaluate((e) => getComputedStyle(e).display),
    ).toBe("table");
    await page.screenshot({ path: `${SHOTS}/desktop-trainers.png`, fullPage: true });

    await page.goto("/waitlist");
    await expect(page.locator(".adm-table thead")).toBeVisible({ timeout: 30000 });
    await page.screenshot({ path: `${SHOTS}/desktop-waitlist.png`, fullPage: true });

    await page.goto("/compose");
    await expect(page.getByRole("heading", { name: "Compose post" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/desktop-compose.png`, fullPage: true });
  });
});

// ENG-1639 — the phone step-down must leave the dashboard's desktop layout as
// it was: 4 tiles in one row, the two panels side by side, a real table.
for (const vp of [
  { name: "laptop-1280", width: 1280, height: 720 },
  { name: "desktop-1920", width: 1920, height: 1080 },
]) {
  test.describe(`dashboard at ${vp.width}×${vp.height} — unchanged`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("4 tiles in a row, two panels side by side, recently published is a table", async ({ page }) => {
      test.setTimeout(120000);
      await signIn(page);

      const tiles = page.locator(".adm-stats .adm-stat");
      await expect(tiles).toHaveCount(4, { timeout: 30000 });
      const tops = await tiles.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      expect(tops.every((t) => t === tops[0])).toBe(true);

      const panels = page.locator(".adm-grid-2 > .adm-card");
      const [race, quiet] = await panels.evaluateAll((els) =>
        els.map((e) => {
          const b = e.getBoundingClientRect();
          return { top: Math.round(b.top), left: b.left, width: b.width };
        }),
      );
      expect(quiet.top).toBe(race.top);
      expect(quiet.left).toBeGreaterThan(race.left);
      expect(race.width).toBeGreaterThan(quiet.width); // 1.4fr vs 1fr

      const table = page.getByTestId("recent-posts");
      await expect(table.locator("tbody tr").first()).toBeVisible({ timeout: 30000 });
      expect(await table.evaluate((e) => getComputedStyle(e).display)).toBe("table");
      await expect(table.locator("thead th", { hasText: "Engagement" })).toBeVisible();
      // The phone caption must not leak onto the desktop table.
      const caption = await table
        .locator('td[data-label="Posted as"]')
        .first()
        .evaluate((e) => getComputedStyle(e, "::before").content);
      expect(caption === "none" || caption === "normal" || caption === "").toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(vp.width);

      await page.screenshot({ path: `${DASH_SHOTS}/${vp.name}-dashboard.png`, fullPage: true });
    });
  });
}
