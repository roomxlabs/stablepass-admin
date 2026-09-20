import { test, expect, type Page } from "@playwright/test";

// ENG-1268 screenshot proofs: Compose's Step 1 "Posting as", and the preview
// head each of the three subjects produces.
//
// Its own spec file, following the precedent ENG-745 set here: compose.spec.ts
// is ENG-558's aspect-ratio evidence and compose-label.spec.ts is ENG-979's
// picker evidence; both are large and both are declared in other tickets'
// surfaces. A third file keeps this ticket's evidence from colliding with
// either.
//
// These are SCREENSHOT proofs, not a second copy of the unit suite. The
// per-subject behaviour is pinned in ComposeScreen.test.tsx and
// PostPreview.test.tsx; what only a browser can show is that the real screen,
// built and served by `next start`, actually renders each head.
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
  // The screen is a client component; wait for something only the HYDRATED
  // tree renders before touching it (the .rx/gotchas.md hydration trap). The
  // subject picker is the right sentinel here — it is this ticket's control
  // and it is client-rendered.
  await expect(page.getByTestId("subject-picker")).toBeVisible({ timeout: 30000 });
}

test("ENG-1268: Horse subject — the head that already shipped, unchanged", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await openCompose(page);

  // Horse is the default: the screen opens on it, which is what keeps the
  // legacy flow the one an operator lands in.
  await expect(page.getByTestId("subject-option-horse")).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("horse-search")).toBeVisible();

  // All four type tiles.
  for (const t of ["video", "photo", "voice", "text"]) {
    await expect(page.getByTestId(`type-option-${t}`)).toBeVisible();
  }

  await page.getByTestId("horse-search").click();
  const firstHorse = page.getByTestId("horse-results").getByRole("button").first();
  await firstHorse.click();
  await expect(page.getByTestId("horse-pick")).toBeVisible();

  await expect(page.getByTestId("post-preview")).toBeVisible();
  await expect(page.getByTestId("preview-avatar-initial")).toBeVisible();
  await page.screenshot({ path: "e2e/__screenshots__/eng1268-subject-horse.png", fullPage: true });
});

test("ENG-1268: Trainer subject — trainer head, no horse, no race badge", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await openCompose(page);

  await page.getByTestId("subject-option-trainer").click();

  // No horse search at all — the block this ticket exists to remove.
  await expect(page.getByTestId("horse-search")).toHaveCount(0);
  await expect(page.getByTestId("trainer-search")).toBeVisible();
  // A trainer post is still all four types.
  for (const t of ["video", "photo", "voice", "text"]) {
    await expect(page.getByTestId(`type-option-${t}`)).toBeVisible();
  }

  await page.getByTestId("trainer-search").click();
  await page.getByTestId("trainer-results").getByRole("button").first().click();
  await expect(page.getByTestId("trainer-pick")).toBeVisible();

  // THE HEAD: the trainer, and NO race badge — race day is a horse fact, and
  // a trainer post has no horse (post.horse_id is null since B1).
  await expect(page.getByTestId("preview-head-name")).not.toHaveText("");
  await expect(page.getByTestId("preview-race-badge")).toHaveCount(0);
  await page.screenshot({
    path: "e2e/__screenshots__/eng1268-subject-trainer.png",
    fullPage: true,
  });
});

test("ENG-1268: StablePass subject — S-mark head, byline, two tiles only", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await openCompose(page);

  await page.getByTestId("subject-option-stablepass").click();

  // Neither identity control: a StablePass post has no horse and no trainer.
  await expect(page.getByTestId("horse-search")).toHaveCount(0);
  await expect(page.getByTestId("trainer-search")).toHaveCount(0);

  // Epic decision 2 — Voice and Text are HIDDEN, not disabled.
  await expect(page.getByTestId("type-option-photo")).toBeVisible();
  await expect(page.getByTestId("type-option-video")).toBeVisible();
  await expect(page.getByTestId("type-option-voice")).toHaveCount(0);
  await expect(page.getByTestId("type-option-text")).toHaveCount(0);

  // Pick a byline from the live post_byline rows the mock serves.
  const select = page.getByTestId("byline-name-select");
  await expect(select).toBeVisible();

  // ENG-1290 — pin the retired-row filter. `page.tsx` reads `post_byline`
  // DIRECTLY with `.is("retired_at", null)`; nothing proved that filter
  // existed, so deleting it passed the whole suite. `pb-3` "Old Wrap Show" is
  // retired in the mock, and this is the assertion that goes red if the
  // filter is dropped.
  await expect(select.locator("option", { hasText: "Old Wrap Show" })).toHaveCount(0);
  await expect(select.locator("option", { hasText: "Racing TV" })).toHaveCount(1);

  await select.selectOption({ label: "Racing TV" });

  // THE HEAD: the S-mark avatar, "stablepass", then the byline — and no race
  // badge, for the same reason the trainer head has none.
  await expect(page.getByTestId("preview-avatar-mark")).toBeVisible();
  await expect(page.getByTestId("preview-head-name")).toHaveText("stablepass");
  await expect(page.getByTestId("preview-head-subline")).toHaveText("Racing TV");
  await expect(page.getByTestId("preview-race-badge")).toHaveCount(0);

  await page.screenshot({
    path: "e2e/__screenshots__/eng1268-subject-stablepass.png",
    fullPage: true,
  });
});

test("ENG-1290: a retired title is absent from the compose picker", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await openCompose(page);

  // The label twin of the byline assertion above: `page.tsx:128` reads
  // `post_label` directly with `.is("retired_at", null)`, and `pl-17`
  // "Old Barn Tour" is the retired fixture that filter must exclude.
  const select = page.getByTestId("label-select");
  await expect(select).toBeVisible({ timeout: 30000 });
  await expect(select.locator("option", { hasText: "Old Barn Tour" })).toHaveCount(0);
  // A live admin-added row IS offered, so the assertion above is proving the
  // filter rather than an empty picker.
  await expect(select.locator("option", { hasText: "Owner Update" })).toHaveCount(1);
});
