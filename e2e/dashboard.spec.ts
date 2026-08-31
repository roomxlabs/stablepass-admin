import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";

// Dashboard screenshot proof (ENG-174 / T4). Backed by the mock Supabase server
// in e2e/global-setup.ts, extended with the dashboard tables (post / reaction /
// bookmark / subscription / race). Serial: signs in on its own fresh context.
test.describe.configure({ mode: "serial" });

// R2 (ENG-244) adds the mobile viewport proofs. Screenshot names follow R1's
// `r1-*` convention rather than the numeric prefix sequence, which is a single
// workspace-wide counter that new files keep colliding on (.rx/gotchas.md).
const MOBILE = { width: 320, height: 700 };
const PHONE_LARGE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 900 };

const CONTROL = "http://127.0.0.1:8787/__control";
async function setEmpty(empty: boolean) {
  await fetch(CONTROL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ empty }),
  });
}

// The acceptance check: the document itself must never scroll sideways.
async function hasNoHorizontalScroll(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
}

// ...but that check ALONE is hollow on a (dash) screen, because two ancestors
// swallow the overflow before the document ever sees it: `.admin-content` is
// `overflow-x: auto` below 900px (globals.css, ENG-243) and `.adm-card` is
// `overflow: hidden` (dashboard.css). A row wider than the phone is therefore
// CLIPPED — invisible to the document gate and to a boundingBox width check,
// since a grid container's own box stays at its containing block's width while
// its tracks paint outside it. So assert the whole containment chain, down to
// the individual rows. (Found by the ENG-245 worker on the sibling screen.)
async function overflowingElements(page: Page) {
  return page.evaluate(() => {
    const sels = [
      ".admin-content",
      ".dash-content .adm-card",
      ".dash-content .adm-stat",
      ".dash-content .adm-race-row",
      ".dash-content .adm-quiet-row",
      ".dash-content .adm-table tr",
      ".dash-content .adm-empty",
    ];
    const bad: string[] = [];
    for (const sel of sels) {
      document.querySelectorAll(sel).forEach((el, i) => {
        // +1 absorbs sub-pixel layout rounding.
        if (el.scrollWidth > el.clientWidth + 1) {
          bad.push(`${sel}[${i}] scrollWidth=${el.scrollWidth} clientWidth=${el.clientWidth}`);
        }
      });
    }
    return bad;
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

test("dashboard — tiles + race day + quiet horses + recently published", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/");

  // Tiles + race-day queue + recently-published table all populated.
  await expect(page.locator(".adm-stats .adm-stat").first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".adm-race-row").first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".adm-quiet-row").first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".adm-table tbody tr").first()).toBeVisible({ timeout: 30000 });

  await page.screenshot({ path: "e2e/__screenshots__/02-dashboard.png", fullPage: true });
});

test("dashboard fits 320px — every section, no horizontal scroll", async ({ page }) => {
  test.setTimeout(90000);
  await setEmpty(false);
  await page.setViewportSize(MOBILE);
  await signIn(page);
  await page.goto("/");

  // All four sections still render — stacking must not drop content.
  const tiles = page.locator(".adm-stats .adm-stat");
  await expect(tiles.first()).toBeVisible({ timeout: 30000 });
  await expect(tiles).toHaveCount(4);
  await expect(page.locator(".adm-race-row").first()).toBeVisible();
  await expect(page.locator(".adm-quiet-row").first()).toBeVisible();
  await expect(page.locator(".adm-table tbody tr").first()).toBeVisible();

  expect(await hasNoHorizontalScroll(page)).toBe(true);
  expect(await overflowingElements(page)).toEqual([]);

  // `.admin-content` is overflow-x:auto below the shell breakpoint (ENG-243),
  // so the document-level check above would still pass with a too-wide child
  // scrolling INSIDE the content well. Measure the widest section box to prove
  // the content genuinely reflowed rather than merely being clipped away.
  const contentWell = page.locator(".dash-content");
  const wellBox = await contentWell.boundingBox();
  expect(wellBox!.width).toBeLessThanOrEqual(MOBILE.width);
  const innerScroll = await contentWell.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(innerScroll).toBeLessThanOrEqual(0);

  // Tiles are 2-col at the floor (the ticket's locked rule), which means the
  // first two tiles share a row: same y, different x.
  const first = (await tiles.nth(0).boundingBox())!;
  const second = (await tiles.nth(1).boundingBox())!;
  expect(second.y).toBe(first.y);
  expect(second.x).toBeGreaterThan(first.x);

  // Race day and quiet horses stack: the second card starts below the first.
  const cards = page.locator(".adm-grid-2 > .adm-card");
  const raceBox = (await cards.nth(0).boundingBox())!;
  const quietBox = (await cards.nth(1).boundingBox())!;
  expect(quietBox.y).toBeGreaterThanOrEqual(raceBox.y + raceBox.height);

  // The recently-published table becomes stacked cards: <thead> is gone.
  await expect(page.locator(".adm-table thead")).toBeHidden();

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "e2e/__screenshots__/r2-mobile-dashboard.png",
    fullPage: true,
  });
});

// "Desktop screenshots unchanged" is an acceptance criterion that CANNOT be
// proved by comparing `02-dashboard.png`: its fixtures are `Date.now()`-relative
// (+2h/+4h/+6h), so that baseline re-renders different clock times on every
// capture and is documented as churning (.rx/gotchas.md). Pin the desktop
// layout invariants instead — deterministic, and it fails loudly if any of R2's
// mobile rules ever leaks above the 720px breakpoint.
test("desktop layout is untouched by the mobile rules", async ({ page }) => {
  test.setTimeout(90000);
  await setEmpty(false);
  await page.setViewportSize(DESKTOP);
  await signIn(page);
  await page.goto("/");
  await expect(page.locator(".adm-stats .adm-stat").first()).toBeVisible({ timeout: 30000 });

  const cols = (sel: string) =>
    page
      .locator(sel)
      .first()
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);

  // Tiles stay 4-across and the two panels stay side by side.
  expect(await cols(".adm-stats")).toBe(4);
  expect(await cols(".adm-grid-2")).toBe(2);

  // The recently-published table stays a real table with a visible header.
  await expect(page.locator(".adm-table thead")).toBeVisible();
  expect(await page.locator(".adm-table").evaluate((el) => getComputedStyle(el).display)).toBe(
    "table",
  );
  // ...and the generated mobile column labels must NOT be painted.
  const labelWidth = await page
    .locator('.adm-table td[data-label]')
    .first()
    .evaluate((el) => getComputedStyle(el, "::before").width);
  expect(["auto", "0px"]).toContain(labelWidth);

  // Race rows keep the desktop 4-column shape (50px 1fr auto auto).
  expect(await cols(".adm-race-row")).toBe(4);

  expect(await hasNoHorizontalScroll(page)).toBe(true);
  expect(await overflowingElements(page)).toEqual([]);
});

test("dashboard fits 375px", async ({ page }) => {
  test.setTimeout(90000);
  await setEmpty(false);
  await page.setViewportSize(PHONE_LARGE);
  await signIn(page);
  await page.goto("/");

  await expect(page.locator(".adm-stats .adm-stat").first()).toBeVisible({ timeout: 30000 });
  expect(await hasNoHorizontalScroll(page)).toBe(true);
  expect(await overflowingElements(page)).toEqual([]);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "e2e/__screenshots__/r2-mobile-dashboard-375.png",
    fullPage: true,
  });
});

// The ticket assumed `POST /__control {empty:true}` produces an empty
// dashboard. It does not: the toggle only zeroes the subscription count and
// the quiet-horse analytics read, while the race-day races, the reaction/save
// counters and the recently-published posts come from handlers that ignore it
// (verified live — the "empty" run still rendered 3 race rows, 3 quiet horses,
// 4 posts and "Reactions 3,420"). Teaching the mock the empty dashboard means
// editing `e2e/mock-supabase.mjs`, which is Do-NOT-touch on this ticket (it is
// shared with every sibling R-slice), so the zero/empty layout is proved by
// swapping the rendered rows for the page's own empty-state markup in the DOM.
// That is exactly the markup `page.tsx` server-renders when a section is
// empty, so the CSS under test is the real thing; only the data is synthetic.
//
// The three strings are READ OUT OF `page.tsx` at run time rather than copied
// here. A hardcoded copy would desync silently the moment anyone rewords an
// empty state, and the test would keep passing while screenshotting text the
// app no longer renders. Reading the source is the same trick the repo already
// uses for CSS (`compose-css.test.ts`) and for the BE contract doc. If the
// markup shape changes, this throws instead of quietly proving nothing.
function emptyCopyFromSource(): string[] {
  // Playwright runs from the repo root (every screenshot path here is
  // root-relative), so resolve the page off cwd rather than __dirname.
  const src = readFileSync(join(process.cwd(), "app", "(dash)", "page.tsx"), "utf8");
  const copy = [...src.matchAll(/<div className="adm-empty">([^<]+)<\/div>/g)].map((m) =>
    m[1].trim(),
  );
  if (copy.length !== 3) {
    throw new Error(
      `expected 3 .adm-empty strings in page.tsx, found ${copy.length} — ` +
        "the empty-state markup changed shape; update this spec.",
    );
  }
  return copy;
}

// Named to disclose what it is: the empty-state CHROME is real (the page's own
// `.adm-empty` markup and CSS), the DATA behind it is synthetic.
test("dashboard zero/empty chrome fits 320px (synthetic DOM — mock cannot empty this page)", async ({
  page,
}) => {
  test.setTimeout(90000);
  // Kept only because it genuinely zeroes the Members tile; it does NOT empty
  // any other section (see the note above). Restored in `finally` regardless.
  await setEmpty(true);
  try {
    await page.setViewportSize(MOBILE);
    await signIn(page);
    await page.goto("/");
    await expect(page.locator(".adm-stats .adm-stat").first()).toBeVisible({ timeout: 30000 });

    await page.evaluate((copy) => {
      // Zero tiles.
      document.querySelectorAll(".adm-stats .adm-stat .num").forEach((n) => {
        n.textContent = "0";
      });
      // Each card: drop its rows/table, append the page's empty-state node.
      const empty = (text: string) => {
        const el = document.createElement("div");
        el.className = "adm-empty";
        el.textContent = text;
        return el;
      };
      const cards = document.querySelectorAll<HTMLElement>(".dash-content .adm-card");
      cards.forEach((card, i) => {
        card
          .querySelectorAll(".adm-race-row, .adm-quiet-row, .adm-table")
          .forEach((row) => row.remove());
        card.appendChild(empty(copy[i]));
      });
      // The quiet-horse count pill goes with the horses.
      document.querySelector(".adm-card-head.tight h2 .pill")?.remove();
    }, emptyCopyFromSource());

    // Assert what the CSS actually has to get right, not what the script above
    // just did. Each empty card must sit inside the 320px viewport and each
    // message must be laid out at its full height with no clipping — that is
    // the mobile padding scale and the card stacking doing their job.
    const cards = page.locator(".dash-content .adm-card");
    await expect(cards).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      const cardBox = (await cards.nth(i).boundingBox())!;
      expect(cardBox.x).toBeGreaterThanOrEqual(0);
      expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(MOBILE.width);

      const msg = cards.nth(i).locator(".adm-empty");
      await expect(msg).toBeVisible();
      const msgBox = (await msg.boundingBox())!;
      expect(msgBox.x).toBeGreaterThanOrEqual(cardBox.x);
      expect(msgBox.x + msgBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
      // Not clipped: the rendered box covers the full wrapped text. `scrollHeight`
      // is a rounded integer while `boundingBox().height` is fractional (84.5 vs
      // 85 here), so compare the ceiling rather than the raw float.
      const scrollH = await msg.evaluate((el) => el.scrollHeight);
      expect(Math.ceil(msgBox.height)).toBeGreaterThanOrEqual(scrollH);
    }

    // Zeroed tiles still sit 2-across and inside the viewport.
    const tiles = page.locator(".adm-stats .adm-stat");
    const t0 = (await tiles.nth(0).boundingBox())!;
    const t1 = (await tiles.nth(1).boundingBox())!;
    expect(t1.y).toBe(t0.y);
    expect(t1.x + t1.width).toBeLessThanOrEqual(MOBILE.width);

    expect(await hasNoHorizontalScroll(page)).toBe(true);
    expect(await overflowingElements(page)).toEqual([]);

    const contentWell = page.locator(".dash-content");
    expect(await contentWell.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(
      0,
    );

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: "e2e/__screenshots__/r2-mobile-dashboard-empty.png",
      fullPage: true,
    });
  } finally {
    // Leave the shared mock populated — sibling specs assume that dataset.
    await setEmpty(false);
  }
});
