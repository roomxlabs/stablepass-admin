import { test, expect, type Page } from "@playwright/test";

// Trainers screenshot proofs (ENG-179), backed by the mock Supabase server.
// The mock's /__control endpoint flips the dataset between populated and empty
// so we can capture both list states plus the add-trainer form.
test.describe.configure({ mode: "serial" });

const CONTROL = "http://127.0.0.1:8787/__control";
async function setEmpty(empty: boolean) {
  await fetch(CONTROL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ empty }),
  });
}

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

test("trainers list renders populated (06-trainers)", async ({ page }) => {
  test.setTimeout(60000);
  await setEmpty(false);
  await signIn(page);
  await page.goto("/trainers");
  await expect(page.getByTestId("trainers-table")).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/06-trainers-list.png", fullPage: true });
});

test("trainers list renders the empty state", async ({ page }) => {
  test.setTimeout(60000);
  await setEmpty(true);
  await signIn(page);
  await page.goto("/trainers");
  await expect(page.getByTestId("trainers-empty")).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/06-trainers-empty.png", fullPage: true });
  await setEmpty(false);
});

test("add-trainer form renders (08-add-trainer)", async ({ page }) => {
  test.setTimeout(60000);
  await signIn(page);
  await page.goto("/trainers/new");
  await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/08-add-trainer.png", fullPage: true });
});

// ENG-766 — marketing-visibility screenshots.

test("marketing toggle ON", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await page.goto("/trainers/t1/edit");
  await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });
  const cb = page.getByTestId("marketing-visible");
  // t1 is seeded marketing_visible in the mock, so this asserts the EDIT PAGE
  // actually seeds the checkbox rather than tolerating either state.
  await expect(cb).toBeChecked();
  // getByText() is a case-insensitive substring match, so the bare string also
  // matches the checkbox's own "Show on marketing site" label — scope to the
  // card heading.
  await page.getByRole("heading", { name: "Marketing site" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "e2e/__screenshots__/18-trainer-marketing-on.png", fullPage: true });
});

test("marketing toggle OFF", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await page.goto("/trainers/t1/edit");
  await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });
  const cb = page.getByTestId("marketing-visible");
  await expect(cb).toBeChecked(); // seeded on from the mock…
  await cb.uncheck();               // …then turned off for this capture.
  await expect(cb).not.toBeChecked();
  await page.getByRole("heading", { name: "Marketing site" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "e2e/__screenshots__/19-trainer-marketing-off.png", fullPage: true });
});

test("trainers list On site badge", async ({ page }) => {
  test.setTimeout(90000);
  await setEmpty(false);
  await signIn(page);
  await page.goto("/trainers");
  await expect(page.getByTestId("trainers-table")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("on-site-badge").first()).toBeVisible();
  const badgeCount = await page.getByTestId("on-site-badge").count();
  expect(badgeCount).toBe(2);
  await page.screenshot({ path: "e2e/__screenshots__/20-trainers-on-site-badge.png", fullPage: true });
});

// ENG-746 — the Website field and the honest slug-collision message.

test("website field seeds from the trainer row", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await page.goto("/trainers/t1/edit");
  await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });

  // t1 is the only fixture carrying a website_url, so a passing assertion here
  // proves the whole seeding path: the edit page selected the column, data.ts
  // mapped it, and the form rendered it. A form that merely renders an empty
  // Website input would fail this.
  const website = page.getByTestId("trainer-website");
  await expect(website).toHaveValue("https://wallerracing.com.au");

  await website.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "e2e/__screenshots__/22-trainer-website-seeded.png", fullPage: true });
});

test("website field is empty for a trainer without one", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await page.goto("/trainers/t2/edit");
  await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });
  // t2 has no website_url. This is the other half of the seeding proof: a form
  // that hardcoded the value, or a mapper that fell back to some default, would
  // fail here even though the test above passed.
  await expect(page.getByTestId("trainer-website")).toHaveValue("");
});

test("slug collision shows the honest message", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);

  // The 409 is injected at the BFF boundary rather than in mock-supabase.mjs on
  // purpose. This POST is issued by the browser, so page.route can intercept it
  // (unlike the server-side Supabase calls, which never pass through Playwright),
  // and it keeps the order-sensitive /rest/v1 dispatcher untouched. The body is
  // the real envelope shape from lib/api/envelope.ts.
  await page.route("**/api/admin/trainers", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "slug_taken", message: "A trainer with that slug already exists." },
          }),
        })
      : route.continue(),
  );

  await page.goto("/trainers/new");
  await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });
  await page.getByTestId("trainer-name").fill("Chris Waller");
  await page.getByTestId("submit-trainer").click();

  const alert = page.locator(".form-err");
  await expect(alert).toBeVisible({ timeout: 30000 });
  // What the ticket requires the copy to carry: the real cause, the value that
  // actually collided, the duplicate-safe fix first, and the rename second.
  await expect(alert).toContainText("unique ID");
  await expect(alert).toContainText("chris-waller");
  await expect(alert).toContainText("Trainers list");
  await expect(alert).toContainText("change the full name slightly");
  // And NOT the claim an earlier draft made: nothing reads trainer.slug, and the
  // member profile resolves by id, so there is no /chris-waller page to point at.
  await expect(alert).not.toContainText("web address");

  await page.screenshot({ path: "e2e/__screenshots__/23-trainer-slug-collision.png", fullPage: true });
});

test("failed photo copy warning", async ({ page }) => {
  test.setTimeout(90000);

  // 1x1 transparent PNG bytes.
  // A 480x480 neutral stone-toned image. Deliberately not a 1x1 pixel: the
  // preview box is 260px tall with object-fit: cover, so a single pixel stretches
  // into a flat block that reads as a rendering fault in the screenshot evidence.
  const PNG = Buffer.from(
    "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",
    "base64",
  );

  // The signed-URL mint for the private bucket -> succeed.
  await page.route("**/storage/v1/object/sign/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ signedURL: "/storage/v1/object/fake-signed.png" }),
    }),
  );
  // The actual signed download -> succeed, return a real PNG.
  await page.route("**/fake-signed.png**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG }),
  );
  // Uploads INTO the public marketing bucket -> FAIL (this is what we are proving).
  await page.route("**/storage/v1/object/marketing-photos/**", (route) => route.abort());
  // Uploads into the private trainer bucket (the form's own photo upload) -> succeed.
  await page.route("**/storage/v1/object/trainer-photos/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ Key: "trainer-photos/x.jpg" }),
    }),
  );

  await signIn(page);
  await page.goto("/trainers/t1/edit");
  await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });

  // Attach a photo so there is something to copy.
  await page.locator("input[type=file]").setInputFiles({
    name: "waller.jpg",
    mimeType: "image/jpeg",
    buffer: PNG,
  });
  // ENG-749: picking a file now opens the crop step, and its overlay would
  // intercept the submit click below. This test is about the marketing copy
  // failing, not about cropping, so take the use-as-is route — it uploads this
  // exact PNG unchanged, which is what the test was written against.
  await page.getByTestId("photo-crop-use-as-is").click();
  await expect(page.getByTestId("photo-crop-dialog")).toBeHidden();
  await expect(page.getByText("Photo added")).toBeVisible({ timeout: 15000 });

  const cb = page.getByTestId("marketing-visible");
  // t1 is seeded marketing_visible in the mock, so this asserts the EDIT PAGE
  // actually seeds the checkbox rather than tolerating either state.
  await expect(cb).toBeChecked();

  await page.getByTestId("submit-trainer").click();
  await expect(page.getByTestId("marketing-photo-warning")).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/21-trainer-marketing-copy-failed.png", fullPage: true });
});

// ===================================================================
// ENG-248 — R6 responsive. Floor 320px, phone 375px; content stacks at
// <720px per the epic's locked rules.
// ===================================================================

const PHONES = [
  { label: "320x700", width: 320, height: 700 },
  { label: "375x812", width: 375, height: 812 },
] as const;

/**
 * The machine-checked no-horizontal-scroll gate.
 *
 * It measures FOUR boxes, not one, because three of them are invisible to a
 * `documentElement`-only check:
 *
 *  - `.admin-content` — globals.css gives it `overflow-x: auto` at the shell
 *    breakpoint, so an over-wide screen scrolls INSIDE the content well and
 *    leaves `documentElement.scrollWidth` innocent.
 *  - `.admin-topbar` — the same, via its own flex row.
 *  - `.adm-form-actions` — the save bar is `position: fixed`, and fixed boxes
 *    contribute NOTHING to the scrollable overflow of the document or of any
 *    overflow ancestor. Verified: forcing 148px of overflow inside the bar at
 *    320px still reads {doc:0, well:0, topbar:0}. Without this probe the one
 *    construct ENG-248 adds would sit outside the ticket's headline gate, and a
 *    longer button label would clip the primary action off-screen on green.
 */
async function overflow(page: Page) {
  return page.evaluate(() => {
    const measure = (el: Element | null) => (el ? el.scrollWidth - el.clientWidth : 0);
    const doc = document.documentElement;
    return {
      doc: doc.scrollWidth - doc.clientWidth,
      well: measure(document.querySelector(".admin-content")),
      topbar: measure(document.querySelector(".admin-topbar")),
      actions: measure(document.querySelector(".adm-form-actions")),
    };
  });
}

async function expectNoHScroll(page: Page) {
  const o = await overflow(page);
  expect(o.doc, "document scrolls sideways").toBeLessThanOrEqual(0);
  expect(o.well, ".admin-content scrolls sideways").toBeLessThanOrEqual(0);
  expect(o.topbar, ".admin-topbar scrolls sideways").toBeLessThanOrEqual(0);
  expect(o.actions, "the sticky save bar scrolls sideways").toBeLessThanOrEqual(0);
}

for (const phone of PHONES) {
  test(`trainers list has no horizontal scroll at ${phone.label}`, async ({ page }) => {
    test.setTimeout(90000);
    await setEmpty(false);
    await page.setViewportSize({ width: phone.width, height: phone.height });
    await signIn(page);
    await page.goto("/trainers");
    await expect(page.getByTestId("trainers-table")).toBeVisible({ timeout: 30000 });
    await expectNoHScroll(page);

    // Rows render as cards: the column header row is gone and the Edit action
    // is a real >=44px target rather than a 12.5px inline link.
    await expect(page.locator(".adm-table thead")).toBeHidden();
    const edit = page.locator(".adm-table td.actions a").first();
    const box = await edit.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test(`add-trainer form stacks with a sticky save bar at ${phone.label}`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width: phone.width, height: phone.height });
    await signIn(page);
    await page.goto("/trainers/new");
    await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });
    await expectNoHScroll(page);

    // 1-col: the two halves of a `.adm-grid-2col` share a left edge.
    const role = page.locator(".adm-contact .adm-input").first();
    const name = page.locator(".adm-contact .adm-input").nth(1);
    const rb = await role.boundingBox();
    const nb = await name.boundingBox();
    expect(nb!.x).toBeCloseTo(rb!.x, 0);
    expect(nb!.y).toBeGreaterThan(rb!.y);

    // Contacts render as cards.
    await expect(page.getByTestId("contact-card").first()).toBeVisible();

    // Sticky save bar: pinned to the bottom of the VIEWPORT while the form is
    // scrolled to the top, i.e. before any of its own content would put it there.
    await page.evaluate(() => window.scrollTo(0, 0));
    const submit = page.getByTestId("submit-trainer");
    const sb = await submit.boundingBox();
    expect(sb!.height).toBeGreaterThanOrEqual(44);
    expect(sb!.y + sb!.height).toBeLessThanOrEqual(phone.height);
    expect(sb!.y).toBeGreaterThan(phone.height * 0.6);

    // Viewport-clipped on purpose: a fullPage capture stitches the fixed bar in
    // at its scroll offset, which reads as a bar floating mid-document. This is
    // what the operator actually sees.
    await page.screenshot({
      path: `e2e/__screenshots__/r6-mobile-add-trainer-sticky-bar-${phone.width}.png`,
    });
  });

  test(`edit trainer fits ${phone.label} and never buries the delete button`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width: phone.width, height: phone.height });
    await signIn(page);
    await page.goto("/trainers/t1/edit");
    await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });
    // The densest screen in the ticket: contacts + upload zone + Danger zone.
    await expectNoHScroll(page);

    // The reserve under the fixed bar is a magic number (76px vs a ~65px bar),
    // so assert the thing it exists to protect instead of the number: at the
    // very bottom of the document the destructive control must still be the
    // element under its own centre point, not the save bar. A hidden-but-enabled
    // delete is the failure mode that actually matters here.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const del = page.getByTestId("delete-trainer-button");
    const box = (await del.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    const onTop = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest("[data-testid=delete-trainer-button]") !== null;
      },
      [box.x + box.width / 2, box.y + box.height / 2] as const,
    );
    expect(onTop, "the save bar is covering the delete button").toBe(true);
  });
}

test("trainers list renders as cards on a phone (populated + empty)", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 375, height: 812 });
  await setEmpty(false);
  await signIn(page);
  await page.goto("/trainers");
  await expect(page.getByTestId("trainers-table")).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/r6-mobile-trainers-list.png", fullPage: true });

  await setEmpty(true);
  await page.goto("/trainers");
  await expect(page.getByTestId("trainers-empty")).toBeVisible({ timeout: 30000 });
  await expectNoHScroll(page);
  await page.screenshot({ path: "e2e/__screenshots__/r6-mobile-trainers-empty.png", fullPage: true });
  await setEmpty(false);
});

test("add-trainer form renders on a phone", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page);
  await page.goto("/trainers/new");
  await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "e2e/__screenshots__/r6-mobile-add-trainer.png", fullPage: true });
});

test("edit-trainer contacts stack as cards on a phone", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page);
  await page.goto("/trainers/t1/edit");
  await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });
  await expectNoHScroll(page);

  const cards = page.getByTestId("contact-card");
  await expect(cards.first()).toBeVisible();

  // Add a second contact so "stacked" is actually observable: card 2 sits
  // BELOW card 1 and shares its left edge.
  await page.getByTestId("add-contact").click();
  await expect(cards).toHaveCount(2);
  const a = await cards.nth(0).boundingBox();
  const b = await cards.nth(1).boundingBox();
  expect(b!.x).toBeCloseTo(a!.x, 0);
  expect(b!.y).toBeGreaterThanOrEqual(a!.y + a!.height);

  // The Remove action on the second contact is a real tap target.
  const remove = page.locator(".adm-contact-remove").first();
  const rb = await remove.boundingBox();
  expect(rb!.height).toBeGreaterThanOrEqual(44);

  await expectNoHScroll(page);
  await page.screenshot({ path: "e2e/__screenshots__/r6-mobile-edit-trainer-contacts.png", fullPage: true });
});

test("desktop trainers layout is unchanged at 1280px", async ({ page }) => {
  test.setTimeout(90000);
  await setEmpty(false);
  await signIn(page);
  await page.goto("/trainers");
  await expect(page.getByTestId("trainers-table")).toBeVisible({ timeout: 30000 });
  // The table is still a table (the responsive rules are behind <=719px) and
  // the save bar on the form is still the plain right-aligned row.
  await expect(page.locator(".adm-table thead")).toBeVisible();
  await page.goto("/trainers/new");
  await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });
  const pos = await page
    .locator(".adm-form-actions")
    .evaluate((el) => getComputedStyle(el).position);
  expect(pos).toBe("static");
});
