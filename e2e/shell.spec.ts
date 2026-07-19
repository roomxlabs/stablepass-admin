import { test, expect, type Page } from "@playwright/test";

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
  await page.getByRole("button", { name: "Sign in" }).click();
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

  const submit = page.getByRole("button", { name: "Sign in" });
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
