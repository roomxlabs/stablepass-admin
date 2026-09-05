import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Responsive shell proof (ENG-243 / R1). Backed by the mock Supabase server in
// e2e/global-setup.ts. Serial: each test signs in on its own fresh context.
test.describe.configure({ mode: "serial" });

const MOBILE = { width: 320, height: 700 };
const PHONE_LARGE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 900 };

// The shell's minimum tap target, per the ticket's locked rules.
const MIN_TAP = 44;

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

// The acceptance check: the document itself must never scroll sideways.
async function hasNoHorizontalScroll(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
}

// The drawer is client state, so a click before React hydrates is simply
// dropped (the markup is already streamed and visible well before that). Wait
// for React to attach to the hamburger before driving it.
async function waitForHydration(page: Page) {
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="admin-hamburger"]');
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

test("sign-in fits 320px with no horizontal scroll and 44px controls", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto("/signin");

  const card = page.locator(".admin-signin-card");
  await expect(card).toBeVisible();
  expect(await hasNoHorizontalScroll(page)).toBe(true);

  // .admin-signin is overflow:hidden, so the scroll check above would pass even
  // if the card were clipped — measure the card itself to prove it truly fits.
  const cardBox = await card.boundingBox();
  expect(cardBox!.width).toBeLessThanOrEqual(MOBILE.width);
  expect(cardBox!.x).toBeGreaterThanOrEqual(0);

  // ENG-370 renamed the password-step submit to "Continue" (two-step sign-in).
  const submit = page.getByRole("button", { name: "Continue" });
  const submitBox = await submit.boundingBox();
  expect(submitBox!.height).toBeGreaterThanOrEqual(MIN_TAP);

  const emailBox = await page.locator("#email").boundingBox();
  expect(emailBox!.height).toBeGreaterThanOrEqual(MIN_TAP);

  await page.screenshot({ path: "e2e/__screenshots__/r1-mobile-signin.png", fullPage: true });
});

test("mobile shell — hamburger opens the drawer; link and Escape close it", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize(MOBILE);
  await signIn(page);
  await page.goto("/");

  await expect(page.locator(".admin-shell")).toBeVisible({ timeout: 30000 });

  // Sidebar out, mobile bar in.
  await expect(page.locator(".admin-sidebar")).toBeHidden();
  const hamburger = page.getByTestId("admin-hamburger");
  await expect(hamburger).toBeVisible();
  await waitForHydration(page);

  expect(await hasNoHorizontalScroll(page)).toBe(true);

  const hamburgerBox = await hamburger.boundingBox();
  expect(hamburgerBox!.width).toBeGreaterThanOrEqual(MIN_TAP);
  expect(hamburgerBox!.height).toBeGreaterThanOrEqual(MIN_TAP);

  await page.screenshot({ path: "e2e/__screenshots__/r1-mobile-shell.png", fullPage: true });

  // Open. The class toggling isn't enough on its own — the drawer starts
  // translated fully off-screen, so assert it actually slid into view (and that
  // the backdrop came with it) before trusting it.
  const drawer = page.getByTestId("admin-drawer");
  const backdrop = page.getByTestId("admin-drawer-backdrop");
  await hamburger.click();
  await expect(drawer).toHaveClass(/open/);
  await expect(hamburger).toHaveAttribute("aria-expanded", "true");
  // The backdrop spans the viewport in both states (only opacity and
  // pointer-events change), so assert what actually differs.
  await expect(backdrop).toHaveClass(/open/);
  await expect
    .poll(async () => backdrop.evaluate((el) => getComputedStyle(el).opacity), { timeout: 5000 })
    .toBe("1");

  // The drawer slides in over 220ms, so poll until it has fully arrived rather
  // than measuring it mid-transition.
  await expect
    .poll(async () => (await drawer.boundingBox())!.x, { timeout: 5000 })
    .toBeGreaterThanOrEqual(0);

  const navLinkBox = await drawer.getByRole("link", { name: /Horses/ }).boundingBox();
  expect(navLinkBox!.height).toBeGreaterThanOrEqual(MIN_TAP);
  expect(navLinkBox!.x).toBeGreaterThanOrEqual(0);

  await page.screenshot({
    path: "e2e/__screenshots__/r1-mobile-drawer.png",
    animations: "disabled",
  });

  // Escape closes — and the drawer leaves the viewport again.
  await page.keyboard.press("Escape");
  await expect(drawer).not.toHaveClass(/open/);
  await expect(hamburger).toHaveAttribute("aria-expanded", "false");
  await expect(drawer).not.toBeInViewport();

  // A nav tap navigates AND closes.
  await hamburger.click();
  await expect(drawer).toHaveClass(/open/);
  await drawer.getByRole("link", { name: /Horses/ }).click();
  await page.waitForURL(/\/horses$/, { timeout: 30000 });
  await expect(drawer).not.toHaveClass(/open/);
  expect(await hasNoHorizontalScroll(page)).toBe(true);
});

test("shell has no horizontal scroll at 375x812", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize(PHONE_LARGE);
  await signIn(page);
  await page.goto("/");

  await expect(page.locator(".admin-shell")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("admin-hamburger")).toBeVisible();
  expect(await hasNoHorizontalScroll(page)).toBe(true);
});

test("desktop keeps the fixed sidebar and hides the mobile chrome", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize(DESKTOP);
  await signIn(page);
  await page.goto("/");

  await expect(page.locator(".admin-sidebar")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("admin-hamburger")).toBeHidden();
  await expect(page.getByTestId("admin-drawer")).toBeHidden();
  expect(await hasNoHorizontalScroll(page)).toBe(true);
});

/* ====================================================================
   ENG-962 — viewport sweep across every dash route.

   The 720-899px band regressed because the SHELL collapses its sidebar at
   max-width:899px while every screen scoped its own content stacking to
   max-width:719px. That left iPad-portrait (768px) rendering desktop tables
   inside a ~734px well.

   Note WHERE the clipping happens, because it decides what this test can
   assert: `.admin-content` is `overflow-x: auto` below 900px, so the DOCUMENT
   never scrolls sideways. The table's wrapper `.adm-card` is
   `overflow: hidden`, and that is what cut the action column off with no way
   to reach it. A `scrollWidth <= clientWidth` check on the document alone
   therefore PASSES on the broken layout — which is why this sweep also hunts
   for clipped-and-unreachable boxes.
   ==================================================================== */

const SWEEP_VIEWPORTS = [
  { name: "phone-390", width: 390, height: 844 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "desktop-1280", width: 1280, height: 900 },
];

// Every route under the (dash) group that renders without a fixture id.
const DASH_ROUTES = [
  "/",
  "/posts",
  "/compose",
  "/horses",
  "/horses/new",
  "/trainers",
  "/trainers/new",
  "/analytics",
  "/waitlist",
];

/**
 * Measure one route for BOTH failure modes.
 *
 * (1) `scrollWidth > innerWidth` — the document itself scrolls sideways.
 *
 * (2) Clipped-and-unreachable content. This is the one the 720-899px gate
 *     failures actually hit, and the reason (1) alone is not enough: a
 *     900px-wide posts table inside a 734px `.adm-card` (`overflow: hidden`)
 *     never moves the document, because `.admin-content` around it is
 *     `overflow-x: auto`. It is simply cut off, with the Unpublish/Delete
 *     column stranded off-screen and no scrollbar to reach it. A container
 *     that clips while its content is wider than its box is content the
 *     operator cannot get to, so it is a failure even though the page "fits".
 *
 * `overflow-x: visible` is deliberately NOT a failure: that content is painted
 *     outside the box rather than hidden (SVG chart labels do this), so it stays
 *     readable and is caught by (1) if it reaches the document edge.
 */
async function measureRoute(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const clipped: string[] = [];
    const content = document.querySelector(".admin-content");

    if (content) {
      // `.admin-content` is included for completeness. Today it is
      // `overflow-x: auto` below 900px, so the filter below skips it — but if
      // anyone ever changes it to `hidden`, a direct overflow of the content
      // well would otherwise go unreported.
      const scope = [content as HTMLElement, ...Array.from(content.querySelectorAll<HTMLElement>("*"))];
      for (const el of scope) {
        const style = getComputedStyle(el);
        const overflowX = style.overflowX;
        if (overflowX !== "hidden" && overflowX !== "clip") continue;
        // Visually-hidden helpers (the compose file input) are 0-1px wide by
        // design and never show content — not an operator-facing clip.
        if (el.clientWidth < 8) continue;
        if (style.opacity === "0" || style.visibility === "hidden") continue;
        // 1px of slack absorbs sub-pixel rounding on fractional layouts.
        if (el.scrollWidth <= el.clientWidth + 1) continue;
        const cls =
          typeof el.className === "string" && el.className.trim()
            ? `.${el.className.trim().split(/\s+/).join(".")}`
            : "";
        clipped.push(
          `${el.tagName.toLowerCase()}${cls} content ${el.scrollWidth}px in a ${el.clientWidth}px box (overflow-x: ${overflowX})`,
        );
      }
    }

    // clientWidth, NOT window.innerWidth: innerWidth INCLUDES the vertical
    // scrollbar, which would let ~15px of real horizontal overflow pass. This
    // matches hasNoHorizontalScroll() above.
    return { scrollWidth: doc.scrollWidth, viewportWidth: doc.clientWidth, clipped };
  });
}

/**
 * Routes still exempt from the CLIP half of the sweep (they are still held to
 * the document-scroll half).
 *
 * `/waitlist` shipped from main on 2 Sep, outside this responsive epic, and has
 * no stacking rules at all — its table is 410px inside a 356px well at 390px,
 * so the "Source"/"Joined" columns are unreachable on a phone. Fixing it means
 * editing `app/(dash)/waitlist/waitlist.css`, which is the live file surface of
 * the still-open PR #75 (ENG-976), so ENG-962 deliberately does NOT touch it —
 * see ENG-986. The exemption is a WIDTH PREDICATE, not a blanket skip, so the
 * route still carries its full desktop guard. Delete this entry with that fix;
 * do not add routes here to make a red sweep go green.
 */
const CLIP_CHECK_EXEMPT: Record<string, (width: number) => boolean> = {
  // Only below the shell breakpoint — /waitlist is fine at 1280, so it keeps
  // full desktop coverage.
  "/waitlist": (width) => width < 900,
};

for (const vp of SWEEP_VIEWPORTS) {
  test(`no horizontal overflow or clipped content on any dash route at ${vp.name}`, async ({
    page,
  }) => {
    test.setTimeout(180000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await signIn(page);

    const failures: string[] = [];

    for (const route of DASH_ROUTES) {
      await page.goto(route);
      await expect(page.locator(".admin-content")).toBeVisible({ timeout: 30000 });

      const m = await measureRoute(page);

      if (m.scrollWidth > m.viewportWidth) {
        failures.push(
          `${route} — document scrolls sideways: scrollWidth ${m.scrollWidth} > clientWidth ${m.viewportWidth}`,
        );
      }
      const exempt = CLIP_CHECK_EXEMPT[route]?.(vp.width) ?? false;
      if (!exempt) {
        for (const c of m.clipped) {
          failures.push(`${route} — clipped, unreachable: ${c}`);
        }
      }
    }

    expect(
      failures,
      `${vp.width}px viewport had ${failures.length} responsive failure(s):\n  ${failures.join("\n  ")}`,
    ).toEqual([]);
  });
}

/* --------------------------------------------------------------------
   ENG-962 — the two failure modes the route sweep above CANNOT see.
   -------------------------------------------------------------------- */

/**
 * Soft-navigation leak.
 *
 * Route CSS persists across soft navigations inside the (dash) group (the same
 * hazard dashboard.css and analytics.css both document). So an UNSCOPED
 * stacking rule from one screen keeps applying on the next one, and the sweep
 * above — which reaches every route with a hard `page.goto()` — is structurally
 * blind to it.
 *
 * This is not hypothetical: posts.css was the epic's one unscoped stylesheet,
 * and widening it to 899px stripped the DASHBOARD table's header at 768px after
 * /posts -> /, while dashboard's own label rules stayed dormant at 719px. The
 * fix was `.posts-screen`; this test is what stops it coming back.
 */
test("posts stacking rules do not leak onto the dashboard after a soft nav (768px)", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 768, height: 1024 });
  await signIn(page);

  const headerDisplay = () =>
    page.evaluate(() => {
      const thead = document.querySelector(".admin-content table.adm-table thead");
      return thead ? getComputedStyle(thead).display : "no-table";
    });

  await page.goto("/");
  await expect(page.locator(".admin-content")).toBeVisible({ timeout: 30000 });
  const onHardNav = await headerDisplay();
  expect(onHardNav, "dashboard should render a real table header at 768px").toBe(
    "table-header-group",
  );

  // Soft-navigate away and back through the drawer, so posts.css stays in the
  // document exactly as it does for a real operator.
  await page.goto("/posts");
  await expect(page.locator(".admin-content")).toBeVisible({ timeout: 30000 });
  await waitForHydration(page);
  await page.getByTestId("admin-hamburger").click();
  await page.getByTestId("admin-drawer").getByRole("link", { name: /Dashboard/ }).click();
  await page.waitForURL("http://127.0.0.1:3002/", { timeout: 30000 });
  await expect(page.locator(".admin-content")).toBeVisible({ timeout: 30000 });

  expect(
    await headerDisplay(),
    "posts.css leaked onto the dashboard: its table header was hidden by another screen's stacking rules",
  ).toBe("table-header-group");
});

/**
 * Compose only overflows AFTER a photo is picked, so the route sweep (which
 * measures the empty screen) cannot guard it.
 *
 * A grid item's automatic minimum size is its MIN-CONTENT, so a 1600px-wide
 * original imposes a 640px floor on the column even though it renders at 358px.
 * Without `min-width: 0` the compose column becomes 384px inside a 358px well.
 *
 * The fixture must be a REAL large image: a 1x1 placeholder reports a 1px
 * intrinsic width and reproduces nothing.
 *
 * Asserts on the CONTAINERS, not on every descendant, because `.uploadMeta` is
 * deliberately `text-overflow: ellipsis` — an intentional truncation the generic
 * clip detector cannot tell apart from a real one.
 */
test("compose fits 390px after a photo is picked", async ({ page }) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 390, height: 844 });
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

  await page.goto("/compose");
  await expect(page.getByRole("heading", { name: "Compose post" })).toBeVisible({ timeout: 30000 });
  await page.getByTestId("horse-search").fill("Mah");
  await page.getByTestId("horse-opt-h1").click();
  await page.getByTestId("caption").fill("Last fast gallop before Saturday.");
  await page.getByTestId("type-option-photo").click();
  await page.getByTestId("media-input").setInputFiles({
    name: "gallop.png",
    mimeType: "image/png",
    buffer: readFileSync("e2e/fixtures/wide-1600x900.png"),
  });
  await expect(page.getByTestId("upload-done")).toBeVisible({ timeout: 20000 });

  const fit = await page.evaluate(() => {
    const doc = document.documentElement;
    const content = document.querySelector(".admin-content") as HTMLElement | null;
    const grid = content?.querySelector("[class*='grid']") as HTMLElement | null;
    return {
      docScroll: doc.scrollWidth,
      viewport: doc.clientWidth,
      contentScroll: content?.scrollWidth ?? 0,
      contentClient: content?.clientWidth ?? 0,
      gridScroll: grid?.scrollWidth ?? 0,
      gridClient: grid?.clientWidth ?? 0,
    };
  });

  expect(fit.docScroll, "document must not scroll sideways at 390px").toBeLessThanOrEqual(
    fit.viewport,
  );
  expect(
    fit.contentScroll,
    `.admin-content overflowed its own box (${fit.contentScroll} > ${fit.contentClient}) — the picked photo's min-content is forcing the column wider than the viewport`,
  ).toBeLessThanOrEqual(fit.contentClient + 1);
  expect(
    fit.gridScroll,
    `the compose grid overflowed (${fit.gridScroll} > ${fit.gridClient}) — check min-width: 0 on .grid > *`,
  ).toBeLessThanOrEqual(fit.gridClient + 1);
});
