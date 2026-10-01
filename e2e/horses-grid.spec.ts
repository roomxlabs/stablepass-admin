import { test, expect, type Page } from "@playwright/test";

// ENG-1583: the horses grid shows 6 horses per row at >= 1280px, and the
// loading skeleton resolves into the same columns. Below 1280 it keeps the
// previous 4 (phone/responsive is ENG-1590's job). Backed by the mock Supabase
// server (e2e/global-setup.ts) — 9 named fixture horses.
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

/** How many items share the first item's row. */
async function firstRowCount(page: Page, selector: string) {
  return page.$$eval(selector, (els) => {
    const top = Math.round(els[0].getBoundingClientRect().top);
    return els.filter((e) => Math.round(e.getBoundingClientRect().top) === top).length;
  });
}

/** Mount the real skeleton markup (SkeletonGrid) against the live stylesheet. */
async function skeletonFirstRow(page: Page) {
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "sk-probe";
    host.style.width = `${document.querySelector(".admin-content")!.clientWidth - 80}px`;
    host.innerHTML = `<div class="sk-grid">${'<div class="sk-tile"><div class="sk sk-photo"></div></div>'.repeat(12)}</div>`;
    document.querySelector(".admin-content")!.appendChild(host);
  });
  const n = await firstRowCount(page, "#sk-probe .sk-tile");
  await page.evaluate(() => document.getElementById("sk-probe")?.remove());
  return n;
}

for (const width of [1280, 1440]) {
  test(`horses grid — 6 per row at ${width}px`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    await page.goto("/horses");
    await expect(page.locator(".horse-card-adm")).toHaveCount(9, { timeout: 30000 });
    // Streamed markup can be in the DOM (count met) before it is revealed.
    await expect(page.locator(".horse-card-adm").last()).toBeVisible({ timeout: 30000 });

    expect(await firstRowCount(page, ".horse-card-adm")).toBe(6);
    expect(await skeletonFirstRow(page)).toBe(6);

    // The fixture names are all short, so swap real-length single-word names
    // into the first two cards: "Kingstonheathhorse" is 18 chars, the Racing
    // Australia maximum; "Superstitiousness" is a long dictionary word. Both
    // were clipped by the card's overflow:hidden at 6 columns (ENG-1583 review).
    await page.$$eval(".horse-card-adm .name", (names) => {
      names[0].textContent = "Kingstonheathhorse";
      names[1].textContent = "Superstitiousness";
    });

    // The tile must still read at 6 columns: nothing is clipped horizontally.
    // The name may wrap (a long one-word name breaks inside the word); the stats line wraps BETWEEN its "N followers" /
    // "N posts" pairs (each pair is nowrap), so a pair wider than the card
    // would show up here as overflow.
    const overflow = await page.$$eval(".horse-card-adm", (cards) =>
      cards.flatMap((c) => {
        const name = c.querySelector(".name") as HTMLElement;
        const stats = c.querySelector(".stats") as HTMLElement;
        const bad: string[] = [];
        if (name.scrollWidth > name.clientWidth + 1) bad.push(`name:${name.textContent}`);
        // Belt and braces: the name's text must end inside the card's box.
        const range = document.createRange();
        range.selectNodeContents(name);
        const textRight = Math.max(...Array.from(range.getClientRects(), (r) => r.right));
        if (textRight > name.getBoundingClientRect().right + 1) bad.push(`name-edge:${name.textContent}`);
        if (stats.scrollWidth > stats.clientWidth + 1) bad.push(`stats:${name.textContent}`);
        return bad;
      }),
    );
    expect(overflow).toEqual([]);

    await page.mouse.move(0, 0);
    await page.screenshot({ path: `e2e/__screenshots__/eng-1583-horses-${width}.png`, fullPage: true });
  });
}

test("horses grid — stays at 4 per row below 1280px", async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1279, height: 900 });
  await signIn(page);
  await page.goto("/horses");
  await expect(page.locator(".horse-card-adm")).toHaveCount(9, { timeout: 30000 });
  // Streamed markup can be in the DOM (count met) before it is revealed.
  await expect(page.locator(".horse-card-adm").last()).toBeVisible({ timeout: 30000 });
  expect(await firstRowCount(page, ".horse-card-adm")).toBe(4);
  expect(await skeletonFirstRow(page)).toBe(4);
});

// Phone (ENG-1590 / A3b): below 768px the grid steps down to 2 per row — it
// was 4 (~67px cards that clipped every name) until then — and the page gains
// no horizontal scroll. The skeleton steps down with it.
test("horses grid — phone 390px is 2 per row", async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/horses");
  await expect(page.locator(".horse-card-adm")).toHaveCount(9, { timeout: 30000 });
  // Streamed markup can be in the DOM (count met) before it is revealed.
  await expect(page.locator(".horse-card-adm").last()).toBeVisible({ timeout: 30000 });
  expect(await firstRowCount(page, ".horse-card-adm")).toBe(2);
  expect(await skeletonFirstRow(page)).toBe(2);
  const scrolls = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(scrolls).toBe(false);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: "e2e/__screenshots__/eng-1583-horses-390.png", fullPage: true });
});
