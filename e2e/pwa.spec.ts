import { test, expect } from "@playwright/test";

// ENG-1591 (A3c) — installable admin PWA. What iOS "Add to Home Screen" and
// Android install actually read, checked against the production build and
// without a session (the installer fetches these signed-out).
test("sign-in page carries the install tags; manifest + icons are served signed-out", async ({
  page,
  request,
}) => {
  await page.goto("/signin");

  const head = page.locator("head");
  await expect(head.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  await expect(head.locator('meta[name="mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
  await expect(head.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute(
    "content",
    "StablePass Admin",
  );
  await expect(head.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute(
    "content",
    "black",
  );
  await expect(head.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#122E26");
  const touch = head.locator('link[rel="apple-touch-icon"]');
  await expect(touch).toHaveCount(1);
  const touchHref = await touch.getAttribute("href");

  const res = await request.get("/manifest.webmanifest");
  expect(res.status()).toBe(200);
  const m = await res.json();
  expect(m).toMatchObject({
    name: "StablePass Admin",
    short_name: "StablePass Admin",
    display: "standalone",
    start_url: "/",
    theme_color: "#122E26",
    background_color: "#FAF7F2",
  });

  const srcs = [...m.icons.map((i: { src: string }) => i.src), touchHref!];
  for (const src of srcs) {
    const r = await request.get(src);
    expect(r.status(), src).toBe(200);
    expect(r.headers()["content-type"], src).toContain("image/png");
  }

  // No service worker is registered (stale-admin caching is out by design).
  const regs = await page.evaluate(async () =>
    "serviceWorker" in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
  );
  expect(regs).toBe(0);
});
