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

test("dashboard fits 375px", async ({ page }) => {
  test.setTimeout(90000);
  await setEmpty(false);
  await page.setViewportSize(PHONE_LARGE);
  await signIn(page);
  await page.goto("/");

  await expect(page.locator(".adm-stats .adm-stat").first()).toBeVisible({ timeout: 30000 });
  expect(await hasNoHorizontalScroll(page)).toBe(true);

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
const EMPTY_COPY = {
  race: "No platform horses racing in the next 24 hours.",
  quiet: "Every active horse has posted this week. 🎉",
  recent: "No published posts yet.",
};

test("dashboard zero/empty states fit 320px", async ({ page }) => {
  test.setTimeout(90000);
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
      const texts = [copy.race, copy.quiet, copy.recent];
      cards.forEach((card, i) => {
        card
          .querySelectorAll(".adm-race-row, .adm-quiet-row, .adm-table")
          .forEach((row) => row.remove());
        card.appendChild(empty(texts[i]));
      });
      // The quiet-horse count pill goes with the horses.
      document.querySelector(".adm-card-head.tight h2 .pill")?.remove();
    }, EMPTY_COPY);

    await expect(page.locator(".adm-empty")).toHaveCount(3);
    await expect(page.locator(".adm-empty").first()).toBeVisible();
    await expect(page.locator(".adm-race-row")).toHaveCount(0);
    expect(await hasNoHorizontalScroll(page)).toBe(true);

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
