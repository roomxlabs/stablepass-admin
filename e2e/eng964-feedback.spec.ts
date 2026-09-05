import { test, expect, type Page, type Route } from "@playwright/test";

// ENG-964 screenshot proofs: route skeletons, publish/unpublish toasts, and the
// sticky table header. Backed by the same mock Supabase server as every other
// spec — this file adds NO fixtures to e2e/mock-supabase.mjs (two other open
// PRs are editing it), and instead intercepts at the browser edge for the two
// states the fixtures cannot produce on demand:
//
//  * the SKELETON turned out NOT to be reachable this way at all — see the long
//    note on the skipped test below. It is kept as the record of the dead end.
//  * the FAILURE toast needs a publish that loses. The publish route
//    re-asserts its precondition on the UPDATE itself (ENG-950), so a 409 is a
//    real outcome; fulfilling it here proves the client surfaces it instead of
//    optimistically showing the post as published.
test.describe.configure({ mode: "serial" });

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

/** Hold every RSC fetch for `path` (prefetch included) so its loading.tsx
 *  stays on screen long enough to capture. Returns the handle to unroute. */
async function stallRoute(page: Page, path: string, ms = 8000) {
  const matcher = (url: URL) => url.pathname === path && url.searchParams.has("_rsc");
  const fn = async (route: Route) => {
    await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  };
  await page.route(matcher, fn);
  return { matcher, fn };
}

// SKIPPED, deliberately, with the method kept as the record of how the skeleton
// screenshots in this PR were actually produced.
//
// A browser-side stall CANNOT surface `loading.tsx`: Next commits a soft
// navigation only once the RSC payload arrives, so delaying that response just
// freezes the page you are already on (`location.pathname` never changes) and
// the boundary never mounts. The loading UI is what the SERVER streams while it
// is still rendering, so the delay has to be on the data the server reads, not
// on the wire to the browser.
//
// The committed screenshots were therefore captured against a deliberately
// slowed backend: a delay proxy in front of e2e/mock-supabase.mjs, with the app
// rebuilt against it (`NEXT_PUBLIC_*` is inlined at BUILD time, so setting it
// only at `next start` changes nothing). ~900ms is the window that works — long
// enough that a multi-query page holds its skeleton for seconds, short enough
// that the (dash) layout's own requireAdminPage() gate still commits the shell.
// That rig needs its own build + ports, so it is not wired into this suite;
// `app/(dash)/loading.test.tsx` is what actually GATES the five skeletons.
test.skip("skeletons — posts, horses, trainers, analytics, dashboard", async ({ page }) => {
  test.setTimeout(180000);
  await signIn(page);

  for (const [path, nav, shot] of [
    ["/posts", "Posts", "18-skeleton-posts.png"],
    ["/horses", "Horses", "18-skeleton-horses.png"],
    ["/trainers", "Trainers", "18-skeleton-trainers.png"],
    ["/analytics", "Analytics", "18-skeleton-analytics.png"],
  ] as const) {
    // The stall is armed BEFORE the dashboard renders, on purpose. `<Link>`
    // prefetches every nav target as soon as it paints, and a prefetched
    // dynamic route resolves from cache on click — the navigation then
    // completes without ever showing the boundary. Arming first means the
    // prefetch is held too, so the click has nothing cached to jump to and
    // loading.tsx is what the operator actually sees.
    const handler = await stallRoute(page, path);
    await page.goto("/");
    await page.getByRole("link", { name: nav, exact: true }).first().click();
    const sk = page.locator('[data-testid="route-skeleton"]');
    await expect(sk).toBeVisible({ timeout: 20000 });
    // The skeleton must announce itself rather than present 40 grey boxes.
    await expect(sk).toHaveAttribute("aria-busy", "true");
    await page.screenshot({ path: `e2e/__screenshots__/${shot}` });
    await page.unroute(handler.matcher, handler.fn);
  }
});

// The token is asserted on EVERY route that renders a topbar, not just the one
// it was derived from. The first cut of this checked `/posts` alone and passed
// while the token was wrong by 2.75px on /analytics (a taller PeriodToggle in
// `.actions`) and 1px on /waitlist (a bare SearchField, no button) — where the
// sticky header tucked under the topbar and was painted over by it. The bar is
// now pinned with a min-height so every screen agrees; this loop is what stops
// that regressing the moment someone puts a taller control in `.actions`.
test("--admin-topbar-h matches the real topbar on every route", async ({ page }) => {
  test.setTimeout(180000);
  await signIn(page);
  for (const path of ["/", "/posts", "/horses", "/trainers", "/analytics", "/waitlist", "/compose"]) {
    await page.goto(path);
    const bar = page.locator(".admin-topbar").first();
    await expect(bar).toBeVisible({ timeout: 30000 });
    const box = await bar.boundingBox();
    const declared = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--admin-topbar-h")),
    );
    expect(Math.abs(declared - box!.height), `--admin-topbar-h vs real topbar on ${path}`).toBeLessThan(1);
  }
});

test("sticky table header — header stays under the topbar when the list scrolls", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await page.goto("/posts");
  await expect(page.locator(".adm-table tbody tr").first()).toBeVisible({ timeout: 30000 });

  const topbarBox = await page.locator(".admin-topbar").boundingBox();
  const th = page.locator(".adm-table thead th").first();
  const before = await th.boundingBox();

  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(400);
  const after = await th.boundingBox();

  // The header stuck: it did not scroll away with its rows, and it parked
  // immediately below the sticky topbar rather than under or over it.
  expect(after!.y).toBeGreaterThan(before!.y - 900 + 100);
  expect(Math.abs(after!.y - (topbarBox!.y + topbarBox!.height))).toBeLessThan(4);

  await page.screenshot({ path: "e2e/__screenshots__/18-sticky-thead.png" });
});

test("toast — unpublish succeeds", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await page.route("**/api/admin/posts/*/unpublish", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"data":{"ok":true}}' }),
  );
  await page.goto("/posts");
  await expect(page.locator(".adm-table tbody tr").first()).toBeVisible({ timeout: 30000 });

  await page.getByRole("button", { name: "Unpublish" }).first().click();

  const polite = page.locator('[aria-live="polite"]');
  await expect(polite.getByText(/Post unpublished/)).toBeVisible({ timeout: 15000 });
  // Optimistic: that row's affordance flipped before the refresh landed.
  await expect(page.getByRole("button", { name: "Republish" }).first()).toBeVisible();
  // Let the 160ms fade settle so the proof shows the toast, not a frame of it.
  await page.waitForTimeout(500);
  await page.screenshot({ path: "e2e/__screenshots__/18-toast-success.png" });
});

test("toast — publish loses the race and says so", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await page.route("**/api/admin/posts/*/publish", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: '{"error":{"code":"conflict","message":"That post was already published by someone else."}}',
    }),
  );
  await page.goto("/posts?status=scheduled");
  const publish = page.getByRole("button", { name: "Publish now" }).first();
  await expect(publish).toBeVisible({ timeout: 30000 });
  await publish.click();

  const assertive = page.locator('[aria-live="assertive"]');
  await expect(assertive.getByText(/already published by someone else/)).toBeVisible({ timeout: 15000 });
  // The failure must NOT be shown as a success: the row keeps its action.
  await expect(page.getByRole("button", { name: "Publish now" }).first()).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "e2e/__screenshots__/18-toast-error.png" });
});
