import { test, expect, type Page } from "@playwright/test";

// Horses DB screenshot proofs (ENG-178). Backed by the mock Supabase server in
// e2e/global-setup.ts. Serial: each test signs in on its own fresh context.
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

// ENG-247 / R5: the responsive proofs. Viewports and the "no horizontal
// scroll" rule are the epic's (320px floor, 320x700 + 375x812).
const MOBILE = { width: 320, height: 700 };
const PHONE_LARGE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 900 };
const MIN_TAP = 44;

// Two checks, because one is not enough. The document check is the epic's
// stated rule, but at the shell breakpoint globals.css puts `overflow-x: auto`
// on `.admin-content` — so a too-wide grid scrolls INSIDE the content well and
// the document check stays green while the screen is still broken. Measure the
// content well itself as well (same reasoning as R1 measuring the sign-in card
// rather than trusting an overflow:hidden parent).
async function expectNoHorizontalScroll(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
    "document must not scroll sideways",
  ).toBe(true);
  // querySelectorAll, not querySelector: the EDIT page renders two content
  // wells — `.admin-content.horse-form` and the `.admin-content.horse-form-tail`
  // that carries DangerDelete — and each gets its own `overflow-x: auto` scroll
  // container below 900px. Measuring only the first would let the danger zone
  // scroll sideways inside its own well with this helper still green.
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll(".admin-content")].every(
        (el) => el.scrollWidth <= el.clientWidth,
      ),
    ),
    "every .admin-content well must not scroll sideways either",
  ).toBe(true);
}

/** The number of tracks the grid actually renders. */
function gridColumns(page: Page) {
  return page
    .getByTestId("horse-grid")
    .evaluate((el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length);
}

test("horses list — populated", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/horses");
  await expect(page.locator(".horse-card-adm").first()).toBeVisible({ timeout: 30000 });

  // Assert CARD CONTENT, not just that a card exists. Visibility alone passed
  // against a grid of 24 empty cards for the whole of ENG-178 → ENG-285: the
  // mock was serving bare `{ trainer_id }` stubs and nothing noticed. These
  // assertions fail if the horse reads ever fall back to stub rows again.
  const first = page.locator(".horse-card-adm").first();
  await expect(first).toContainText("Mahogany");
  await expect(first).toContainText("Chris Waller");
  // Real follower/post counts, not the `0 followers · 0 posts` of a stub row.
  await expect(first).not.toContainText("Unassigned trainer");
  await expect(first).not.toContainText("0 followers");

  // The named fixture set is 9 horses (not the 24 trainer-roster stubs), and
  // the filter chips derive their counts from the same rows.
  await expect(page.locator(".horse-card-adm")).toHaveCount(9);
  await expect(page.getByText("Verry Elleegant")).toBeVisible();
  await expect(page.getByText("Black Caviar")).toBeVisible();
  await expect(page.getByText("Winx")).toBeVisible();

  // ENG-616: the meta line is now sourced from the database's computed columns,
  // not from a TypeScript formula. Assert the SHAPE it produces, per case.
  //
  // A gelding reads "gelding" at any age.
  await expect(first.locator(".meta")).toHaveText(/^by Chris Waller · \d+yo gelding$/);
  // A retired horse drops the age entirely and shows the training status —
  // that comes from training_status, which the DB derivation does NOT cover.
  await expect(page.locator(".horse-card-adm", { hasText: "Winx" }).locator(".meta")).toHaveText(
    "by Chris Waller · retired",
  );
  // No foaling year and no sex on record: no age, and no invented description.
  await expect(page.locator(".horse-card-adm", { hasText: "Barrier Trial" }).locator(".meta")).toHaveText(
    "by James Cummings",
  );
  await page.screenshot({ path: "e2e/__screenshots__/05-horses-list.png", fullPage: true });
});

test("horses list — empty", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/horses?q=__none__");
  await expect(page.locator(".horse-empty")).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/05-horses-empty.png", fullPage: true });
});

test("add horse form", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/horses/new");
  await expect(page.getByRole("button", { name: "Add to library" }).first()).toBeVisible({ timeout: 30000 });

  // ENG-616: two options, nothing preselected, and a Gelded checkbox that is
  // inert until Male is chosen.
  const sex = page.locator("#horse-sex");
  await expect(sex.locator("option:not([disabled])")).toHaveCount(2);
  await expect(sex.locator("option:not([disabled])")).toHaveText(["Male", "Female"]);
  await expect(sex).toHaveValue("");
  await expect(page.locator("#horse-gelded")).toBeDisabled();

  await page.screenshot({ path: "e2e/__screenshots__/07-add-horse.png", fullPage: true });

  // Male enables it; Female clears AND disables it again.
  await sex.selectOption("male");
  await expect(page.locator("#horse-gelded")).toBeEnabled();
  await page.locator("#horse-gelded").check();
  await expect(page.locator("#horse-gelded")).toBeChecked();
  await sex.selectOption("female");
  await expect(page.locator("#horse-gelded")).not.toBeChecked();
  await expect(page.locator("#horse-gelded")).toBeDisabled();
});

test("edit horse form — an existing gelding prefills Male + Gelded", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/horses/h1/edit");
  await expect(page.getByRole("button", { name: "Save changes" }).first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#horse-sex")).toHaveValue("male");
  await expect(page.locator("#horse-gelded")).toBeChecked();
  await page.screenshot({ path: "e2e/__screenshots__/08-edit-horse.png", fullPage: true });
});

test("edit horse form — a NULL-sex row prefills neither", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/horses/h9/edit");
  await expect(page.getByRole("button", { name: "Save changes" }).first()).toBeVisible({ timeout: 30000 });
  // Never defaulted to Male: guessing a sex is exactly what this epic removed.
  await expect(page.locator("#horse-sex")).toHaveValue("");
  await expect(page.locator("#horse-gelded")).not.toBeChecked();
  await expect(page.locator("#horse-gelded")).toBeDisabled();
});

/* ====================================================================
   ENG-247 / R5 — mobile responsive proofs.
   ==================================================================== */

test("R5 — horses list is 1-col at 320px with no horizontal scroll", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize(MOBILE);
  await signIn(page);
  await page.goto("/horses");
  await expect(page.locator(".horse-card-adm").first()).toBeVisible({ timeout: 30000 });

  expect(await gridColumns(page)).toBe(1);
  await expectNoHorizontalScroll(page);

  // Prove the card really fits the viewport rather than being clipped by an
  // overflow ancestor: it must start on-screen and be no wider than the phone.
  const card = await page.locator(".horse-card-adm").first().boundingBox();
  expect(card!.x).toBeGreaterThanOrEqual(0);
  expect(card!.width).toBeLessThanOrEqual(MOBILE.width);

  // Chips wrap onto more than one row instead of pushing the bar wide, and the
  // search drops to its own full-width row below them.
  const chips = page.locator(".adm-filter-bar .chip");
  await expect(chips).toHaveCount(4);
  const firstChip = await chips.first().boundingBox();
  const lastChip = await chips.last().boundingBox();
  expect(lastChip!.y).toBeGreaterThan(firstChip!.y);
  expect(firstChip!.height).toBeGreaterThanOrEqual(MIN_TAP);
  const search = await page.locator(".adm-filter-bar .search-mini").boundingBox();
  expect(search!.y).toBeGreaterThan(lastChip!.y);

  await page.screenshot({ path: "e2e/__screenshots__/r5-mobile-horses-list.png", fullPage: true });
});

test("R5 — horses list is 1-col at 375x812 too", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize(PHONE_LARGE);
  await signIn(page);
  await page.goto("/horses");
  await expect(page.locator(".horse-card-adm").first()).toBeVisible({ timeout: 30000 });
  expect(await gridColumns(page)).toBe(1);
  await expectNoHorizontalScroll(page);
});

test("R5 — horses empty state fits 320px", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize(MOBILE);
  await signIn(page);
  await page.goto("/horses?q=__none__");
  await expect(page.locator(".horse-empty")).toBeVisible({ timeout: 30000 });
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "e2e/__screenshots__/r5-mobile-horses-empty.png", fullPage: true });
});

// The acceptance criteria name BOTH phone widths for BOTH forms, so the add and
// edit checks run at each rather than one apiece. 320x700 on the edit page is
// the most load-bearing combination: it is the floor width on the only route
// that renders two `.admin-content` wells (the form and the Danger zone).
for (const vp of [MOBILE, PHONE_LARGE]) {
  const label = `${vp.width}x${vp.height}`;

  test(`R5 — add horse at ${label}: 1-col fields and a sticky save bar`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize(vp);
    await signIn(page);
    await page.goto("/horses/new");
    const save = page
      .getByTestId("horse-form-actions")
      .getByRole("button", { name: "Add to library" });
    await expect(save).toBeVisible({ timeout: 30000 });

    await expectNoHorizontalScroll(page);

    // Every field grid is a single track — Foaling year / Sex / Colour is the
    // 3-col row, Starts / Wins / Places / Prize the 4-col one.
    const tracks = await page
      .locator(
        ".horse-form .field-grid.cols-2, .horse-form .field-grid.cols-3, .horse-form .field-grid.cols-4",
      )
      .evaluateAll((els) =>
        els.map((el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length),
      );
    expect(tracks.length).toBeGreaterThanOrEqual(4);
    expect(tracks.every((n) => n === 1)).toBe(true);

    // The bar is pinned to the viewport, not parked at the bottom of the page:
    // it must be in view BEFORE any scrolling, and sit on the bottom edge.
    const bar = page.getByTestId("horse-form-actions");
    await expect(bar).toBeInViewport();
    expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
    const barBox = (await bar.boundingBox())!;
    expect(barBox.y + barBox.height).toBeGreaterThanOrEqual(vp.height - 2);
    expect(barBox.x).toBe(0);
    // Full-bleed. Not an exact equality: a classic (non-overlay) scrollbar eats
    // a few px of the layout viewport in headless Chromium.
    expect(barBox.width).toBeLessThanOrEqual(vp.width);
    expect(barBox.width).toBeGreaterThanOrEqual(vp.width - 20);
    expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(MIN_TAP);

    // …and it stays there after scrolling to the end of a long form.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(bar).toBeInViewport();

    // Clearance: the last card must not end underneath the bar.
    const lastCard = (await page.locator(".horse-form .adm-card").last().boundingBox())!;
    expect(lastCard.y + lastCard.height).toBeLessThanOrEqual((await bar.boundingBox())!.y);

    if (vp === MOBILE) {
      await page.screenshot({
        path: "e2e/__screenshots__/r5-mobile-add-horse.png",
        fullPage: true,
      });
    }
  });

  test(`R5 — edit horse at ${label}: the sticky bar clears the danger zone`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize(vp);
    await signIn(page);
    await page.goto("/horses/h1/edit");
    await expect(
      page.getByTestId("horse-form-actions").getByRole("button", { name: "Save changes" }),
    ).toBeVisible({ timeout: 30000 });

    // Covers BOTH content wells on this route — see expectNoHorizontalScroll.
    await expectNoHorizontalScroll(page);
    const bar = page.getByTestId("horse-form-actions");
    expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");

    // The Danger zone renders AFTER the form, so it is what the fixed bar would
    // cover if the clearance sat only on the form body.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const danger = (await page.getByTestId("delete-horse").boundingBox())!;
    const barBox = (await bar.boundingBox())!;
    expect(danger.y + danger.height).toBeLessThanOrEqual(barBox.y);

    if (vp === PHONE_LARGE) {
      await page.screenshot({
        path: "e2e/__screenshots__/r5-mobile-edit-horse.png",
        fullPage: true,
      });
    }
  });
}

test("R5 — desktop is unchanged: 4-col grid, no fixed save bar", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize(DESKTOP);
  await signIn(page);
  await page.goto("/horses");
  await expect(page.locator(".horse-card-adm").first()).toBeVisible({ timeout: 30000 });
  expect(await gridColumns(page)).toBe(4);
  await expectNoHorizontalScroll(page);

  await page.goto("/horses/new");
  const bar = page.getByTestId("horse-form-actions");
  await expect(bar).toBeVisible({ timeout: 30000 });
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe("static");
});
