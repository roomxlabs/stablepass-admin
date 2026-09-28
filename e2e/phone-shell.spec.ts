import { test, expect, type Page } from "@playwright/test";

// ENG-1585 (A3a) — the phone shell. Below 768px the sidebar collapses to an
// off-canvas drawer behind a slim brand bar; desktop is unchanged. Also the
// sign-in + 2FA steps at phone width (scope item 5). Tables/grids at phone
// width are ENG-1590 (A3b), so this spec asserts no sideways scroll only on
// the screens this ticket owns (sign-in, MFA) plus the shell chrome itself.
test.describe.configure({ mode: "serial" });

const PHONE = { width: 390, height: 844 };

async function noHorizontalScroll(page: Page, where: string) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, `horizontal page scroll on ${where}`).toBeLessThanOrEqual(client);
}

async function signIn(page: Page, shots = false) {
  await page.goto("/signin");
  await expect(page.locator("#email")).toBeVisible();
  if (shots) {
    await noHorizontalScroll(page, "/signin");
    await page.screenshot({ path: "e2e/__screenshots__/19-phone-signin.png", fullPage: true });
  }
  await page.locator("#email").fill("ops@stablepass.co");
  await page.locator("#password").fill("correcthorse");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("**/signin/mfa", { timeout: 30000 });
  await expect(page.locator("#code")).toBeVisible();
  if (shots) {
    await noHorizontalScroll(page, "/signin/mfa");
    await page.screenshot({ path: "e2e/__screenshots__/19-phone-signin-mfa.png", fullPage: true });
  }
  await page.locator("#code").fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL("http://127.0.0.1:3002/", { timeout: 30000 });
}

test.describe("phone (390×844)", () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test("sign-in + 2FA fit the phone, and the dashboard opens with the drawer closed", async ({
    page,
  }) => {
    test.setTimeout(90000);
    await signIn(page, true);
    await expect(page.locator(".adm-stats .adm-stat").first()).toBeVisible({ timeout: 30000 });

    const bar = page.locator(".admin-mobilebar");
    const toggle = page.getByRole("button", { name: "Open menu" });
    const drawer = page.locator("#admin-sidebar");
    await expect(bar).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Closed drawer is off-canvas AND hidden, so its links are not focusable.
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("link", { name: "Posts" })).toBeHidden();

    // The content column now spans the full phone width, not 390 - 220.
    const main = await page.locator(".admin-main").boundingBox();
    expect(main!.x).toBe(0);
    expect(main!.width).toBeGreaterThanOrEqual(PHONE.width - 1);

    // The shell chrome itself never pushes the page sideways.
    const barBox = await bar.boundingBox();
    expect(barBox!.width).toBeLessThanOrEqual(PHONE.width);

    await page.screenshot({ path: "e2e/__screenshots__/19-phone-dashboard.png" });
  });

  test("the drawer opens from the bar, closes on scrim / Escape / close button, and on navigation", async ({
    page,
  }) => {
    test.setTimeout(90000);
    await signIn(page);
    await expect(page.locator(".adm-stats .adm-stat").first()).toBeVisible({ timeout: 30000 });

    const toggle = page.getByRole("button", { name: "Open menu" });
    const drawer = page.locator("#admin-sidebar");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(drawer).toBeVisible();
    await expect(page.getByRole("link", { name: "Posts" })).toBeVisible();
    // Sign-out must be ON SCREEN, not merely rendered: a bottom-pinned foot
    // was pushed below the fold when page content overflowed the phone.
    const signOut = await page.getByRole("button", { name: "Sign out" }).boundingBox();
    expect(signOut!.y + signOut!.height).toBeLessThanOrEqual(PHONE.height);
    // Focus moves into the drawer.
    await expect(page.getByRole("button", { name: "Close menu" })).toBeFocused();
    // Wait out the 220ms slide so the screenshot shows the settled drawer.
    await page.waitForTimeout(400);
    await page.screenshot({ path: "e2e/__screenshots__/19-phone-drawer-open.png" });

    // Close button → focus returns to the toggle.
    await page.getByRole("button", { name: "Close menu" }).click();
    await expect(drawer).toBeHidden();
    await expect(toggle).toBeFocused();

    // Escape.
    await toggle.click();
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();

    // Scrim tap (right of the 280px drawer).
    await toggle.click();
    await expect(drawer).toBeVisible();
    await page.mouse.click(360, 500);
    await expect(drawer).toBeHidden();

    // Navigating from the drawer lands on the screen with the drawer shut.
    await toggle.click();
    await page.getByRole("link", { name: "Posts" }).click();
    await page.waitForURL("**/posts", { timeout: 30000 });
    await expect(drawer).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".admin-topbar h1")).toBeVisible();

    // Tapping the link for the page you're ALREADY on still closes it.
    await toggle.click();
    await expect(drawer).toBeVisible();
    await page.getByRole("link", { name: "Posts" }).click();
    await expect(drawer).toBeHidden();

    // The page topbar parks UNDER the sticky brand bar, not behind it.
    const barBox = await page.locator(".admin-mobilebar").boundingBox();
    const topbarBox = await page.locator(".admin-topbar").boundingBox();
    expect(topbarBox!.y).toBeGreaterThanOrEqual(barBox!.y + barBox!.height - 1);
  });
});

test.describe("desktop (1280×900)", () => {
  test("the sidebar is the unchanged 220px column; no phone chrome", async ({ page }) => {
    test.setTimeout(90000);
    await signIn(page);
    await expect(page.locator(".adm-stats .adm-stat").first()).toBeVisible({ timeout: 30000 });

    await expect(page.locator(".admin-mobilebar")).toBeHidden();
    await expect(page.locator(".admin-drawer-close")).toBeHidden();
    const side = await page.locator("#admin-sidebar").boundingBox();
    expect(side!.x).toBe(0);
    expect(side!.width).toBe(220);
    await expect(page.getByRole("link", { name: "Posts" })).toBeVisible();
    // Topbar still pins at the very top (mobile-bar offset is 0 here).
    const topbar = await page.locator(".admin-topbar").evaluate((el) => getComputedStyle(el).top);
    expect(topbar).toBe("0px");

    await page.screenshot({ path: "e2e/__screenshots__/19-desktop-dashboard.png" });
  });
});
