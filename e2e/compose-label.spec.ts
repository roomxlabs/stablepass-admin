import { test, expect, type Page } from "@playwright/test";

// ENG-745 screenshot proofs: the label picker, the removed caption cap, and the
// horse picker that no longer truncates at 8.
//
// Its own spec file rather than more cases in compose.spec.ts: that file is
// ENG-558's aspect-ratio evidence and is already 19k, and R5 (multi-photo) is
// sequenced straight after this ticket into the same screen. A separate file
// keeps the two from colliding over one spec.
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

async function openCompose(page: Page) {
  await page.goto("/compose");
  // The screen is a client component; wait for something only the hydrated
  // tree renders before touching it (the .rx/gotchas.md hydration trap).
  await expect(page.getByTestId("label-select")).toBeVisible({ timeout: 30000 });
}

// ENG-979 — the picker is now ONE field ("Title"), reads its options LIVE from
// `post_label`, and grows through Add-new. The option set is therefore the
// mock's seeded rows in the route's ordering, not the compile-time preset copy:
// asserting against `POST_LABEL_PRESETS` here would only prove the two arrays
// match, not that the screen read the table.
const SEEDED_LABELS = [
  "Stable Update",
  "Pre Race Report",
  "Post Race Report",
  "Trackwork",
  "Trial",
  "Race Replay",
  "Race Result",
  "Race Day \u00b7 Today",
  "Pre Training Update",
  "Spelling Update",
  "Breaking In Update",
  "Race Preview",
  "Jockey Comments",
  "Trainer Comments",
  // Admin-added rows collate after every builtin, alphabetically.
  "Float Trip",
  "Owner Update",
];
const ADD_NEW = "__stablepass_add_new_label__";

test("ENG-979: ONE field, live options from post_label, Add new last", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await openCompose(page);

  // The acceptance criterion: one field, not two. The free-text title input is
  // gone, and the single control is labelled "Title".
  await expect(page.getByTestId("title")).toHaveCount(0);
  const select = page.getByTestId("label-select");
  await expect(page.locator('label[for="post-label"]')).toHaveText("Title");

  const values = await select.locator("option").evaluateAll((opts) =>
    opts.map((o) => (o as HTMLOptionElement).value),
  );
  // Read from the TABLE, in the route's order, with Add-new pinned last.
  expect(values).toEqual(["", ...SEEDED_LABELS, ADD_NEW]);

  await select.selectOption("Trackwork");
  await expect(select).toHaveValue("Trackwork");
  await select.scrollIntoViewIfNeeded();
  await expect(select).toBeInViewport();
  await page.screenshot({ path: "e2e/__screenshots__/18-compose-label-picker.png" });

  await select.evaluate((el) => {
    (el as HTMLSelectElement).size = 18;
  });
  await select.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "e2e/__screenshots__/19-compose-label-options.png" });
});

test("ENG-979: Add new creates a label, selects it, and it survives a reload", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await openCompose(page);

  const select = page.getByTestId("label-select");
  await select.selectOption(ADD_NEW);

  // The inline field opens; the sentinel never becomes the value.
  const field = page.getByTestId("add-label-row");
  await expect(field).toBeVisible();
  await expect(select).toHaveValue("");
  await field.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "e2e/__screenshots__/24-compose-add-new-open.png" });

  await page.getByTestId("new-label-input").fill("Float Trip Notes");
  await page.getByTestId("add-label-save").click();

  // Created AND selected in the one interaction.
  await expect(select).toHaveValue("Float Trip Notes", { timeout: 15000 });
  await expect(field).toBeHidden();
  await select.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "e2e/__screenshots__/25-compose-add-new-selected.png" });

  // "present in the dropdown on the next compose without a deploy" — the row
  // was really written, so a fresh page load reads it back from the table.
  await page.reload();
  await expect(page.getByTestId("label-select")).toBeVisible({ timeout: 30000 });
  const after = await page
    .getByTestId("label-select")
    .locator("option")
    .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
  expect(after).toContain("Float Trip Notes");
});

test("ENG-979: a duplicate differing only by case selects the existing row", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await openCompose(page);

  const select = page.getByTestId("label-select");
  const before = await select
    .locator("option")
    .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));

  await select.selectOption(ADD_NEW);
  // Different case AND a trailing space — both must fold to the existing row.
  await page.getByTestId("new-label-input").fill("  trackwork ");
  await page.getByTestId("add-label-save").click();

  // The CANONICAL spelling is selected, not what was typed.
  await expect(select).toHaveValue("Trackwork", { timeout: 15000 });

  // And no second row was created: the option set is unchanged.
  const after = await select
    .locator("option")
    .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
  expect(after).toEqual(before);
  expect(after.filter((v) => v.toLowerCase() === "trackwork")).toHaveLength(1);
});

// NOTE: the old "label picker: the 13 presets plus No label" test lived here.
// ENG-979 supersedes it — the first test in this file asserts the same option
// set and captures the same two screenshots, but against the LIVE `post_label`
// rows rather than the compile-time preset array, which is the behaviour that
// now matters. Keeping both also made the suite order-dependent: the specs run
// serially against ONE mock server, so the Add-new test's insert is visible to
// every test after it, and a second hardcoded full-list assertion goes red the
// moment anything upstream adds a label.

test("caption: no cap, and the counter is a plain character count", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await openCompose(page);

  const long =
    "He worked beautifully this morning and pulled up clean. " +
    "The track was rolling and he came home strong through the final two hundred. ";
  const caption = page.getByTestId("caption");
  const text = long.repeat(4).slice(0, 500);
  await caption.fill(text);

  // The value survives in full — this is the regression the cap caused: with
  // maxLength the textarea silently kept only the first 240 characters.
  expect(await caption.inputValue()).toHaveLength(500);
  await expect(page.getByTestId("caption-counter")).toHaveText("500 characters");
  // And no maxLength attribute at all.
  expect(await caption.getAttribute("maxlength")).toBeNull();

  await page.screenshot({ path: "e2e/__screenshots__/20-compose-long-caption.png" });
});

test("horse picker: every horse reachable, not the first 8", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await openCompose(page);

  // Open the picker with an EMPTY query — how it opens, and the case the old
  // `slice(0, 8)` broke most visibly.
  await page.getByTestId("horse-search").click();
  const results = page.getByTestId("horse-results");
  await expect(results).toBeVisible();

  const rows = results.locator("li");
  await expect(rows).toHaveCount(12);
  // The 9th and the 12th are the ones the slice used to hide outright.
  await expect(page.getByTestId("horse-opt-h9")).toBeAttached();
  await expect(page.getByTestId("horse-opt-h12")).toBeAttached();
  await page.screenshot({ path: "e2e/__screenshots__/21-compose-horse-picker-full.png" });

  // ...and they are reachable by SCROLLING the bounded list, which is what the
  // max-height on `.results` buys (pinned in compose-css.test.ts).
  await page.getByTestId("horse-opt-h12").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("horse-opt-h12")).toBeInViewport();
  await page.screenshot({ path: "e2e/__screenshots__/22-compose-horse-picker-scrolled.png" });

  // Reachable means selectable, not merely present in the DOM.
  await page.getByTestId("horse-opt-h12").click();
  await expect(page.getByTestId("horse-pick")).toContainText("Zoustar");

  // The text filter still narrows.
  await page.reload();
  await expect(page.getByTestId("label-select")).toBeVisible({ timeout: 30000 });
  await page.getByTestId("horse-search").fill("Star");
  // Case-insensitive SUBSTRING match, so this narrows 12 down to Northern
  // Star and Zou-star — not to one. Asserting the real pair rather than a
  // round number keeps the filter's actual semantics pinned.
  await expect(results.locator("li")).toHaveCount(2);
  await expect(page.getByTestId("horse-opt-h5")).toBeAttached();
  await expect(page.getByTestId("horse-opt-h12")).toBeAttached();
  await expect(page.getByTestId("horse-opt-h1")).toHaveCount(0);
});

// Edit mode is the only path that exercises page.tsx — an async server
// component no unit test can reach. The ComposeScreen unit tests hand `initial`
// in directly, so nothing there proves the PAGE selects `label` and seeds it.
// Deleting `label` from page.tsx's select string leaves the whole vitest suite
// green; these two are what catch it.
test("edit mode seeds the picker from the post's stored label", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await page.goto("/compose?id=ce1");
  await expect(page.getByRole("heading", { name: "Edit post" })).toBeVisible({ timeout: 30000 });

  // Hydrated from the row, not defaulted.
  await expect(page.getByTestId("label-select")).toHaveValue("Trial");
  // ENG-979 — the free-text title input is gone; the picker IS the title field.
  await expect(page.getByTestId("title")).toHaveCount(0);
  await page.screenshot({ path: "e2e/__screenshots__/23-compose-edit-label-seeded.png" });
});

test("edit mode opens an unlabelled post on No label", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await page.goto("/compose?id=ce2");
  await expect(page.getByRole("heading", { name: "Edit post" })).toBeVisible({ timeout: 30000 });

  // The pre-2026-08-19 state: no label, and the picker must not invent one.
  await expect(page.getByTestId("label-select")).toHaveValue("");
});
