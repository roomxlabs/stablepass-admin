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

// ENG-245 / R3 — the epic's locked mobile viewports and content breakpoint.
const MOBILE = { width: 320, height: 700 };
const PHONE_LARGE = { width: 375, height: 812 };
const MIN_TAP = 44;

// The acceptance check. Testing `documentElement` ALONE is not enough on this
// screen and would be a hollow gate: ENG-243's shell gives `.admin-content`
// `overflow-x: auto` below 900px expressly so a too-wide child scrolls inside
// the content well instead of moving the document, and `.adm-card` is
// `overflow: hidden`, which clips whatever is left. A card overflowing its
// 320px width would therefore be silently cropped with the document still
// reporting scrollWidth 320. So assert on every element that can actually
// report the overflow: the document, the scrollable content well, the card, and
// each post card.
const OVERFLOW_SCOPES = ["html", ".admin-content", ".adm-card", '[data-testid="post-card"]'];
async function hasNoHorizontalScroll(page: Page) {
  return page.evaluate((scopes) => {
    for (const sel of scopes) {
      for (const el of document.querySelectorAll(sel)) {
        // +1px: sub-pixel layout rounding, not a real overflow.
        if (el.scrollWidth > el.clientWidth + 1) return false;
      }
    }
    return true;
  }, OVERFLOW_SCOPES);
}

// The cards are client-interactive (row click → router.push), so a click before
// React attaches is simply dropped. Wait for the fiber, as shell.spec.ts does.
async function waitForHydration(page: Page) {
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="post-card"]');
      return (
        !!el &&
        Object.keys(el).some(
          (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactProps$"),
        )
      );
    },
    undefined,
    { timeout: 30000 },
  );
}

test("posts library — populated", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/posts");
  await expect(page.locator(".adm-table tbody tr").first()).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/04-posts-list.png", fullPage: true });
});

test("posts library — empty", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/posts?q=__none__");
  await expect(page.locator(".posts-empty")).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/04-posts-empty.png", fullPage: true });
});

test("posts library at 320px — cards, wrapped chips, no horizontal scroll", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize(MOBILE);
  await signIn(page);
  await page.goto("/posts");

  const cards = page.getByTestId("post-card");
  await expect(cards.first()).toBeVisible({ timeout: 30000 });

  // The acceptance number: nothing may push the document sideways at the floor.
  expect(await hasNoHorizontalScroll(page)).toBe(true);

  // Cards, not table rows: the header is gone and each card is a stacked block
  // that spans the card well rather than a 7-column row.
  await expect(page.locator(".adm-table thead")).toBeHidden();
  const cardBox = (await cards.first().boundingBox())!;
  expect(cardBox.x).toBeGreaterThanOrEqual(0);
  expect(cardBox.width).toBeLessThanOrEqual(MOBILE.width);
  // A row this tall is only possible stacked — the desktop row is ~60px.
  expect(cardBox.height).toBeGreaterThan(120);

  // Chips wrapped onto more than one line, and each is a real tap target.
  const chips = page.locator(".adm-filter-bar .chip");
  const chipBoxes = await chips.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, h: r.height })),
  );
  expect(chipBoxes.length).toBe(5);
  expect(new Set(chipBoxes.map((b) => Math.round(b.y))).size).toBeGreaterThan(1);
  for (const b of chipBoxes) {
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.h).toBeGreaterThanOrEqual(MIN_TAP);
  }

  // The filter-mini search is full-width under the chips (desktop pins it to a
  // 240px min-width, which alone would overflow a 320px viewport).
  const searchBox = (await page.locator(".adm-filter-bar .search-mini").boundingBox())!;
  expect(searchBox.width).toBeGreaterThan(MOBILE.width * 0.8);

  // The pagination footer wraps rather than squeezing the pager off the card:
  // the "Showing N of M" line and the pager sit on different rows.
  const foot = await page
    .locator(".posts-foot")
    .evaluate((el) => ({
      count: el.firstElementChild!.getBoundingClientRect(),
      pager: el.querySelector(".pager")!.getBoundingClientRect(),
    }));
  expect(Math.round(foot.pager.y)).toBeGreaterThan(Math.round(foot.count.y));
  expect(foot.pager.x).toBeGreaterThanOrEqual(0);

  await page.screenshot({ path: "e2e/__screenshots__/r3-mobile-posts.png", fullPage: true });
});

test("posts library at 320px — a card tap opens the post, an action does not", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize(MOBILE);
  await signIn(page);
  await page.goto("/posts");
  await expect(page.getByTestId("post-card").first()).toBeVisible({ timeout: 30000 });
  await waitForHydration(page);

  // An action acts in place: the URL must still be /posts afterwards. (Whether
  // the mock accepts the mutation is irrelevant — either outcome is in-place.)
  const action = page.locator('[data-testid="post-card"] td.actions button').first();
  await expect(action).toBeVisible();
  const actionBox = (await action.boundingBox())!;
  expect(actionBox.height).toBeGreaterThanOrEqual(MIN_TAP);
  await action.click();
  await page.waitForTimeout(1500);
  expect(new URL(page.url()).pathname).toBe("/posts");

  // Tapping the card body itself DOES navigate to the post detail.
  await page.getByTestId("post-card").first().locator(".row-name").click();
  await page.waitForURL(/\/compose\?id=/, { timeout: 30000 });
});

test("posts library — empty state and cards fit 375x812", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize(PHONE_LARGE);
  await signIn(page);

  await page.goto("/posts");
  await expect(page.getByTestId("post-card").first()).toBeVisible({ timeout: 30000 });
  expect(await hasNoHorizontalScroll(page)).toBe(true);

  await page.goto("/posts?q=__none__");
  await expect(page.locator(".posts-empty")).toBeVisible({ timeout: 30000 });
  expect(await hasNoHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: "e2e/__screenshots__/r3-mobile-posts-empty.png", fullPage: true });
});

test("the desktop table is unchanged above the 720px breakpoint", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await page.goto("/posts");
  await expect(page.locator(".adm-table tbody tr").first()).toBeVisible({ timeout: 30000 });

  // The header row is back, the row is a table row again, and the re-attached
  // card labels are hidden (the <thead> carries them here).
  await expect(page.locator(".adm-table thead")).toBeVisible();
  await expect(page.locator(".adm-table thead th")).toHaveCount(7);
  const display = await page
    .getByTestId("post-card")
    .first()
    .evaluate((el) => getComputedStyle(el).display);
  expect(display).toBe("table-row");
  await expect(page.locator(".cell-label").first()).toBeHidden();
  expect(await hasNoHorizontalScroll(page)).toBe(true);
});
