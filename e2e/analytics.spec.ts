import { test, expect, type Page } from "@playwright/test";

// Analytics screenshot proofs (ENG-276), backed by the mock Supabase server.
// The mock's /__control endpoint flips the dataset between populated and empty
// so we capture both the populated screen and the new-platform all-zeros state.
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

// ENG-881 / R2b — the epic's locked mobile viewports and content breakpoint.
const MOBILE = { width: 320, height: 700 };
const PHONE_LARGE = { width: 375, height: 812 };
const MIN_TAP = 44;

// The acceptance check. Testing `documentElement` ALONE is not enough here and
// would be a hollow gate: ENG-243's shell gives `.admin-content`
// `overflow-x: auto` below 900px expressly so a too-wide child scrolls inside
// the content well instead of moving the document, and `.adm-card` is
// `overflow: hidden`, which clips whatever is left. A card overflowing its
// 320px width would therefore be silently cropped with the document still
// reporting scrollWidth 320. So assert on every element that can actually
// report the overflow — the document, the scrollable content well, each card,
// each stat tile and each row-card.
const OVERFLOW_SCOPES = [
  "html",
  ".admin-content",
  ".adm-card",
  ".adm-stat",
  ".adm-table tbody tr",
  ".chart-wrap",
];
// On DESKTOP the card-level scopes cannot be asserted: the "Members on trial"
// card overflows its 1fr grid track by 5px at 1280px (a 4-column table with
// 22px gutters in the narrow half of the 1.4fr/1fr grid) and is clipped by
// `.adm-card { overflow: hidden }`. That is PRE-EXISTING — ENG-881 is a
// below-720px change and its one desktop-reaching declaration,
// `.cell-label { display: none }`, contributes no layout box at all. Acceptance
// 3 requires desktop to stay pixel-equal, so this ticket must NOT fix it;
// filed as a note on the epic instead. Desktop therefore asserts the document
// and the content well, which is what "no horizontal scroll" means there.
const DESKTOP_OVERFLOW_SCOPES = ["html", ".admin-content"];

// Two screens, two honest scope sets. The per-post screen has no `.adm-table`
// at all, and the all-zeros state renders `.chart-empty` INSTEAD of each table,
// so demanding the table scope there would fail the "every scope matched
// something" check for the right reason but the wrong cause.
const POST_OVERFLOW_SCOPES = ["html", ".admin-content", ".adm-card", ".adm-stat", ".chart-wrap"];
const EMPTY_OVERFLOW_SCOPES = ["html", ".admin-content", ".adm-card", ".adm-stat", ".chart-empty"];

/**
 * Every scope that overflowed, plus how many elements each scope matched.
 *
 * The count matters as much as the verdict: a `page.evaluate` loop over
 * `querySelectorAll` returns "clean" for a scope that matched NOTHING, so a
 * renamed class would quietly shrink this gate to fewer scopes and stay green
 * with no signal. Callers assert on `matched` too, which is what keeps the
 * strongest part of this spec from rotting invisibly.
 */
async function overflowReport(page: Page, scopes = OVERFLOW_SCOPES) {
  return page.evaluate((sels) => {
    const matched: Record<string, number> = {};
    const overflowing: string[] = [];
    for (const sel of sels) {
      const els = [...document.querySelectorAll(sel)];
      matched[sel] = els.length;
      for (const el of els) {
        // +1px: sub-pixel layout rounding, not a real overflow.
        if (el.scrollWidth > el.clientWidth + 1) overflowing.push(sel);
      }
    }
    return { matched, overflowing: [...new Set(overflowing)] };
  }, scopes);
}

/** Asserts nothing overflows AND that every scope actually measured something. */
async function expectNoHorizontalScroll(page: Page, scopes = OVERFLOW_SCOPES) {
  const { matched, overflowing } = await overflowReport(page, scopes);
  expect(overflowing, `these scopes scroll sideways: ${overflowing.join(", ")}`).toEqual([]);
  for (const sel of scopes) {
    expect(matched[sel], `scope "${sel}" matched no elements — the gate has rotted`).toBeGreaterThan(
      0,
    );
  }
}

/** Distinct rounded y-offsets — how many visual rows a set of boxes occupies. */
async function rowCount(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((els) => {
    const ys = els.map((el) => Math.round(el.getBoundingClientRect().y));
    return new Set(ys).size;
  });
}

test("analytics renders populated (09-analytics)", async ({ page }) => {
  test.setTimeout(60000);
  await setEmpty(false);
  await signIn(page);
  await page.goto("/analytics");
  await expect(page.getByTestId("analytics-tiles")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("opens-by-day")).toBeVisible();
  await expect(page.getByTestId("trainer-engagement")).toBeVisible();
  await page.screenshot({ path: "e2e/__screenshots__/09-analytics.png", fullPage: true });
});

test("period toggle drives the ?period= search param", async ({ page }) => {
  test.setTimeout(60000);
  await setEmpty(false);
  await signIn(page);
  await page.goto("/analytics");
  await expect(page.getByTestId("period-toggle")).toBeVisible({ timeout: 30000 });

  // Default is 30 days; switching to 7 days must reload the server component.
  await page.getByRole("link", { name: "7 days" }).click();
  await page.waitForURL(/\/analytics\?period=7d/, { timeout: 30000 });
  await expect(page.getByRole("link", { name: "7 days" })).toHaveClass(/active/);
});

test("analytics renders the empty state", async ({ page }) => {
  test.setTimeout(60000);
  await setEmpty(true);
  await signIn(page);
  await page.goto("/analytics");
  await expect(page.getByTestId("trainers-empty")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("top-posts-empty")).toBeVisible();
  await page.screenshot({ path: "e2e/__screenshots__/09-analytics-empty.png", fullPage: true });
  await setEmpty(false);
});

test("per-post analytics renders (10-post-analytics)", async ({ page }) => {
  test.setTimeout(60000);
  await setEmpty(false);
  await signIn(page);
  await page.goto("/analytics/posts/pa1");
  await expect(page.getByTestId("post-tiles")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("post-opens")).toBeVisible();
  await expect(page.getByTestId("post-reactions")).toBeVisible();
  await page.screenshot({ path: "e2e/__screenshots__/10-post-analytics.png", fullPage: true });
});

test("a top-post row links through to its per-post page", async ({ page }) => {
  test.setTimeout(60000);
  await setEmpty(false);
  await signIn(page);
  await page.goto("/analytics");
  await expect(page.getByTestId("top-posts")).toBeVisible({ timeout: 30000 });
  await page.getByRole("link", { name: "Last fast gallop before Saturday" }).click();
  await page.waitForURL(/\/analytics\/posts\/pa1/, { timeout: 30000 });
  await expect(page.getByTestId("post-tiles")).toBeVisible();
});

/* ====================================================================
   ENG-881 / R2b — analytics at the epic's mobile viewports.
   ==================================================================== */

test("analytics at 320px — tiles two-up, charts stacked, tables as cards", async ({ page }) => {
  test.setTimeout(90000);
  await setEmpty(false);
  await page.setViewportSize(MOBILE);
  await signIn(page);
  await page.goto("/analytics");
  await expect(page.getByTestId("analytics-tiles")).toBeVisible({ timeout: 30000 });

  // The acceptance number, measured where the overflow can actually surface.
  await expectNoHorizontalScroll(page);

  // Five summary tiles over three rows rather than one 5-up row of 44px slivers.
  const tiles = page.locator('[data-testid="analytics-tiles"] .adm-stat');
  await expect(tiles).toHaveCount(5);
  expect(await rowCount(page, '[data-testid="analytics-tiles"] .adm-stat')).toBe(3);
  const tileBoxes = await tiles.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x, w: r.width })),
  );
  for (const box of tileBoxes) expect(box.x).toBeGreaterThanOrEqual(0);
  // The first four sit two-up: comfortably under half the viewport each.
  for (const box of tileBoxes.slice(0, 4)) {
    expect(box.w).toBeLessThan(MOBILE.width * 0.55);
  }
  // The odd fifth spans the row rather than leaving a ragged half-width tile.
  expect(tileBoxes[4].w).toBeGreaterThan(MOBILE.width * 0.8);
  expect(tileBoxes[4].w).toBeGreaterThan(tileBoxes[0].w * 1.8);

  // The 1.4fr/1fr chart pair is one column now: the two cards stack.
  const chartCards = page.locator(".adm-grid-2").first().locator("> .adm-card");
  await expect(chartCards).toHaveCount(2);
  const [top, bottom] = await chartCards.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect()).map((r) => ({ y: r.y, w: r.width })),
  );
  expect(Math.round(bottom.y)).toBeGreaterThan(Math.round(top.y));
  expect(top.w).toBeGreaterThan(MOBILE.width * 0.8);

  // Tables became cards: the header row is gone and a row is a stacked block.
  await expect(page.locator('[data-testid="trainer-engagement"] thead')).toBeHidden();
  const row = page.getByTestId("trainer-row").first();
  const rowBox = (await row.boundingBox())!;
  expect(rowBox.x).toBeGreaterThanOrEqual(0);
  expect(rowBox.width).toBeLessThanOrEqual(MOBILE.width);
  // Six columns stacked over a name + three metric rows — the desktop row is ~55px.
  expect(rowBox.height).toBeGreaterThan(120);

  // …and each metric kept its heading, re-attached inline.
  await expect(row.locator(".cell-label")).toHaveCount(5);
  await expect(row.locator(".cell-label").first()).toBeVisible();

  // The period toggle is a full-width date control with real tap targets.
  const toggleBox = (await page.getByTestId("period-toggle").boundingBox())!;
  expect(toggleBox.width).toBeGreaterThan(MOBILE.width * 0.8);
  for (const b of await page
    .locator(".period-toggle a")
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) {
    expect(b).toBeGreaterThanOrEqual(MIN_TAP);
  }

  await page.screenshot({
    path: "e2e/__screenshots__/r2b-mobile-analytics.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("analytics + per-post fit 375x812, populated and empty", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize(PHONE_LARGE);
  await setEmpty(false);
  await signIn(page);

  await page.goto("/analytics");
  await expect(page.getByTestId("analytics-tiles")).toBeVisible({ timeout: 30000 });
  await expectNoHorizontalScroll(page);

  // Per-post: tiles two-up, the two chart cards stacked, emoji bars intact.
  await page.goto("/analytics/posts/pa1");
  await expect(page.getByTestId("post-tiles")).toBeVisible({ timeout: 30000 });
  await expectNoHorizontalScroll(page, POST_OVERFLOW_SCOPES);
  expect(await rowCount(page, '[data-testid="post-tiles"] .adm-stat')).toBe(2);
  const emojiTrack = await page.locator(".emoji-row .track").first().boundingBox();
  expect(emojiTrack!.width).toBeGreaterThan(80);
  await page.screenshot({
    path: "e2e/__screenshots__/r2b-mobile-post-analytics.png",
    fullPage: true,
    animations: "disabled",
  });

  // The all-zeros state: every card falls back to its quiet empty message and
  // still has to fit — a `.chart-empty` is padded, not measured, so a 320px
  // regression would otherwise hide here.
  await setEmpty(true);
  await page.setViewportSize(MOBILE);
  await page.goto("/analytics");
  await expect(page.getByTestId("trainers-empty")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("top-posts-empty")).toBeVisible();
  await expectNoHorizontalScroll(page, EMPTY_OVERFLOW_SCOPES);
  await page.screenshot({
    path: "e2e/__screenshots__/r2b-mobile-analytics-empty.png",
    fullPage: true,
    animations: "disabled",
  });
  await setEmpty(false);
});

test("the drawer carries the Analytics entry and it navigates", async ({ page }) => {
  test.setTimeout(90000);
  await setEmpty(false);
  await page.setViewportSize(MOBILE);
  await signIn(page);

  // ENG-243's shell predates the analytics screen; this is ENG-881's check that
  // the rebased drawer actually offers the route (the desktop sidebar is hidden
  // below 900px, so without this entry /analytics is unreachable on a phone).
  const drawer = page.getByTestId("admin-drawer");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(drawer).toHaveClass(/open/);
  // The drawer slides 220ms — poll rather than measuring it mid-transition.
  await expect
    .poll(async () => (await drawer.boundingBox())!.x, { timeout: 5000 })
    .toBeGreaterThanOrEqual(0);

  const entry = drawer.getByRole("link", { name: /Analytics/ });
  await expect(entry).toHaveCount(1);
  const entryBox = (await entry.boundingBox())!;
  expect(entryBox.height).toBeGreaterThanOrEqual(MIN_TAP);
  expect(entryBox.x).toBeGreaterThanOrEqual(0);

  await entry.click();
  await page.waitForURL(/\/analytics$/, { timeout: 30000 });
  await expect(drawer).not.toHaveClass(/open/);
  await expect(page.getByTestId("analytics-tiles")).toBeVisible({ timeout: 30000 });
});

test("the desktop analytics layout is unchanged above the 720px breakpoint", async ({ page }) => {
  test.setTimeout(90000);
  await setEmpty(false);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await page.goto("/analytics");
  await expect(page.getByTestId("analytics-tiles")).toBeVisible({ timeout: 30000 });

  // Five tiles on ONE row, the header rows are back, a row is a table row
  // again, and the inline card labels are hidden.
  expect(await rowCount(page, '[data-testid="analytics-tiles"] .adm-stat')).toBe(1);
  await expect(page.locator('[data-testid="trainer-engagement"] thead')).toBeVisible();
  await expect(page.locator('[data-testid="trainer-engagement"] thead th')).toHaveCount(6);
  const display = await page
    .getByTestId("trainer-row")
    .first()
    .evaluate((el) => getComputedStyle(el).display);
  expect(display).toBe("table-row");
  await expect(page.locator(".cell-label").first()).toBeHidden();

  // Both chart cards share a row again (the 1.4fr / 1fr grid), and the wider
  // 1.4fr track is back — a 1fr/1fr collapse would make them equal.
  const [left, right] = await page
    .locator(".adm-grid-2")
    .first()
    .locator("> .adm-card")
    .evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect()).map((r) => ({ y: Math.round(r.y), w: r.width })),
    );
  expect(right.y).toBe(left.y);
  expect(left.w).toBeGreaterThan(right.w * 1.3);
  await expectNoHorizontalScroll(page, DESKTOP_OVERFLOW_SCOPES);

  // …and the pre-existing trials-card overflow is pinned at exactly ONE card,
  // so this ticket's mobile rules cannot quietly add a second one on desktop.
  const overflowing = await page.evaluate(() =>
    [...document.querySelectorAll(".adm-card, .adm-stat, .chart-wrap")].filter(
      (el) => el.scrollWidth > el.clientWidth + 1,
    ).length,
  );
  expect(overflowing).toBe(1);
});
