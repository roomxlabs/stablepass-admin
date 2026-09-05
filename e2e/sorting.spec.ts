import { test, expect, type Page } from "@playwright/test";

// ENG-963 — screenshot proofs for URL-driven sorting across the three admin
// lists, plus the trainers ⇄ posts scope jump.
//
// Backed by e2e/mock-supabase.mjs (no live backend). The mock does not
// implement PostgREST `order=`/`eq` semantics, so these specs prove the UI
// CONTRACT — the header is a link, `aria-sort` moves with it, the URL carries
// the sort, the controls render — while the ORDERING ITSELF is proven by the
// unit tests against the query builder (lib/posts/sort.ts, trainers/data.ts).
test.describe.configure({ mode: "serial" });

const SCOPED_TRAINER = "9f1c7a2e-4b3d-4a5f-8c6e-2d1b0a9f8e7d";

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

test("posts — sortable headers, default (unsorted) state", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/posts");
  await expect(page.locator(".adm-table tbody tr").first()).toBeVisible({ timeout: 30000 });

  // Unsorted: every sortable header reports aria-sort="none".
  for (const col of ["horse", "status", "published", "engagement"]) {
    await expect(page.getByTestId(`th-${col}`)).toHaveAttribute("aria-sort", "none");
  }
  await page.screenshot({ path: "e2e/__screenshots__/15-posts-sortable-default.png", fullPage: true });
});

test("posts — clicking a header sorts via the URL and sets aria-sort", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/posts");
  await expect(page.locator(".adm-table tbody tr").first()).toBeVisible({ timeout: 30000 });

  // A first click on a COUNT column opens descending (biggest first).
  await page.getByTestId("th-engagement").getByRole("link").click();
  await page.waitForURL(/sort=engagement&dir=desc/, { timeout: 30000 });
  await expect(page.getByTestId("th-engagement")).toHaveAttribute("aria-sort", "descending");
  // Exactly ONE column ever reports a sort.
  await expect(page.locator("th[aria-sort='descending'], th[aria-sort='ascending']")).toHaveCount(1);
  await page.screenshot({ path: "e2e/__screenshots__/16-posts-sorted-engagement.png", fullPage: true });

  // Clicking the ACTIVE column flips it.
  await page.getByTestId("th-engagement").getByRole("link").click();
  await page.waitForURL(/sort=engagement&dir=asc/, { timeout: 30000 });
  await expect(page.getByTestId("th-engagement")).toHaveAttribute("aria-sort", "ascending");
});

test("posts — the sort header is keyboard-operable", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/posts");
  await expect(page.locator(".adm-table tbody tr").first()).toBeVisible({ timeout: 30000 });

  // Focus the header link directly and activate it with the keyboard only —
  // no click. It is an <a href>, so Enter follows it with no key handler.
  const link = page.getByTestId("th-published").getByRole("link");
  await link.focus();
  await expect(link).toBeFocused();
  await page.keyboard.press("Enter");
  await page.waitForURL(/sort=published&dir=desc/, { timeout: 30000 });
  await expect(page.getByTestId("th-published")).toHaveAttribute("aria-sort", "descending");
});

test("posts — sort survives a filter change", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/posts?sort=published&dir=asc");
  await expect(page.locator(".adm-table tbody tr").first()).toBeVisible({ timeout: 30000 });
  await page.getByRole("link", { name: /^Published/ }).first().click();
  // The status chip navigated, and the sort came with it.
  await page.waitForURL(/status=published/, { timeout: 30000 });
  await expect(page).toHaveURL(/sort=published/);
  await expect(page).toHaveURL(/dir=asc/);
  // The filtered+sorted page must actually RENDER. `waitForURL` is happy with
  // an error page, so without this the run stayed green while
  // /posts?status=published 500'd (a mock-fixture shadowing bug, fixed in
  // e2e/mock-supabase.mjs alongside this spec).
  await expect(page.locator(".adm-table tbody tr").first()).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("th-published")).toHaveAttribute("aria-sort", "ascending");
  await page.screenshot({ path: "e2e/__screenshots__/22-posts-filtered-sorted.png", fullPage: true });
});

test("posts — trainer scope bar (the posts half of the two-way jump)", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto(`/posts?trainerId=${SCOPED_TRAINER}`);
  const scope = page.getByTestId("trainer-scope");
  await expect(scope).toBeVisible({ timeout: 30000 });
  await expect(scope).toContainText("Gai Waterhouse");
  await expect(scope.getByRole("link", { name: "Their horses" })).toBeVisible();
  await expect(scope.getByRole("link", { name: "Show all posts" })).toBeVisible();
  await page.screenshot({ path: "e2e/__screenshots__/17-posts-trainer-scope.png", fullPage: true });
});

test("trainers — sortable headers and the row-count footer", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/trainers");
  await expect(page.getByTestId("trainers-table")).toBeVisible({ timeout: 30000 });

  // The footer count the list was missing.
  await expect(page.getByTestId("trainers-count")).toContainText("trainers");
  await page.screenshot({ path: "e2e/__screenshots__/18-trainers-sortable.png", fullPage: true });

  // Horses is a derived column — sorted after the per-trainer merge.
  await page.getByTestId("th-horses").getByRole("link").click();
  await page.waitForURL(/sort=horses&dir=desc/, { timeout: 30000 });
  await expect(page.getByTestId("th-horses")).toHaveAttribute("aria-sort", "descending");

  // Biggest roster first: the top row must not have fewer horses than the next.
  const counts = await page
    .locator('[data-testid="trainer-horses-link"], .adm-table tbody tr td:nth-child(3)')
    .allInnerTexts();
  const nums = counts.map((t) => parseInt(t.replace(/\D/g, ""), 10)).filter((n) => !Number.isNaN(n));
  expect(nums.length).toBeGreaterThan(1);
  expect(nums[0]).toBeGreaterThanOrEqual(nums[1]);
  await page.screenshot({ path: "e2e/__screenshots__/19-trainers-sorted-horses.png", fullPage: true });
});

test("trainers — the last-post cell jumps to that trainer's posts", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/trainers");
  await expect(page.getByTestId("trainers-table")).toBeVisible({ timeout: 30000 });
  await page.getByTestId("trainer-posts-link").first().click();
  await page.waitForURL(/\/posts\?trainerId=/, { timeout: 30000 });
});

test("horses — sort select in the filter bar", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/horses");
  await expect(page.locator(".horse-card-adm").first()).toBeVisible({ timeout: 30000 });

  const select = page.getByLabel("Sort horses");
  await expect(select).toBeVisible();
  await page.screenshot({ path: "e2e/__screenshots__/20-horses-sort-select.png", fullPage: true });

  // Changing it navigates, and the choice is in the URL (so it is shareable).
  await select.selectOption("name");
  await page.waitForURL(/sort=name/, { timeout: 30000 });
  await expect(select).toHaveValue("name");
  await page.screenshot({ path: "e2e/__screenshots__/21-horses-sorted-name.png", fullPage: true });

  // A→Z: the first card must not sort after the second.
  const names = await page.locator(".horse-card-adm .name").allInnerTexts();
  expect(names.length).toBeGreaterThan(1);
  expect(names[0].localeCompare(names[1], undefined, { sensitivity: "base" })).toBeLessThanOrEqual(0);
});

test("horses — sort survives a status filter change", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/horses?sort=followers");
  await expect(page.locator(".horse-card-adm").first()).toBeVisible({ timeout: 30000 });
  await page.getByRole("link", { name: /^Racing/ }).click();
  await page.waitForURL(/filter=racing/, { timeout: 30000 });
  await expect(page).toHaveURL(/sort=followers/);
});
