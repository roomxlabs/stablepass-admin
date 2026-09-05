import { test, expect, type Page } from "@playwright/test";

// ENG-980 — the two defects Mel demoed on the 2 Sep call, as evidence.
//
// Kept in its own spec rather than added to photo-crop.spec.ts: that file is
// ENG-749's proof that the crop CHANGES THE STORED BYTES, and it is worth
// keeping legible as that. This one is about the range of motion the dialog
// offers, which is a different claim and needs a different pair of screenshots.
//
// The subject is generated in-page, off-centre and wider than tall, for the
// reason ENG-749 gives: real client photos must never reach a PR screenshot
// (.rx/gotchas.md, ENG-558), and an off-centre subject is what makes a framing
// bug visible at all.
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

/**
 * A 2:1 landscape "horse" — the shape that could not be zoomed out. The whole
 * subject spans nearly the full width, so a full-height square crop (the old
 * floor) necessarily cuts its nose and tail off, and fitting it in the square
 * is only possible with the new sub-1 zoom.
 */
async function pickWideHorse(page: Page) {
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 800;
    const ctx = canvas.getContext("2d")!;

    const bg = ctx.createLinearGradient(0, 0, 1600, 800);
    bg.addColorStop(0, "#122E26");
    bg.addColorStop(1, "#285D50");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 1600, 800);
    ctx.fillStyle = "rgba(250,247,242,0.06)";
    for (let x = 0; x < 1600; x += 80) ctx.fillRect(x, 0, 40, 800);

    // A long body from x=120 to x=1480: wider than any square that fits inside
    // an 800px-high source, which is the whole point of the fixture.
    ctx.fillStyle = "#C9A56F";
    ctx.beginPath();
    ctx.ellipse(800, 430, 600, 180, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(1400, 330, 130, 0, Math.PI * 2); // head, hard right
    ctx.fill();
    ctx.fillRect(150, 380, 90, 60); // tail, hard left

    ctx.fillStyle = "#FAF7F2";
    ctx.font = "600 40px Inter, sans-serif";
    ctx.fillText("← NOSE TO TAIL →", 560, 700);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92),
    );
    const file = new File([blob!], "wide-horse.jpg", { type: "image/jpeg" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function openHorseCrop(page: Page) {
  await signIn(page);
  await page.goto("/horses/new");
  await expect(page.getByRole("button", { name: "Add to library" }).first()).toBeVisible({
    timeout: 30000,
  });
  await pickWideHorse(page);
  await expect(page.getByTestId("photo-crop-dialog")).toBeVisible({ timeout: 20000 });
}

const zoom = (page: Page) => page.getByTestId("photo-crop-zoom");

test("crop: BEFORE — the default fill crop cuts the ends off the horse (40)", async ({ page }) => {
  test.setTimeout(120000);
  await openHorseCrop(page);

  // The starting state is unchanged by this ticket: a full-bleed square. On a
  // 2:1 source that square is 800px of a 1600px photo, so half the horse is
  // outside the frame — this screenshot is the "before" the ticket asks for.
  await expect(page.getByTestId("photo-crop-meta")).toContainText("from a 1600×800 photo");
  await expect(page.getByTestId("photo-crop-viewport")).toHaveAttribute("data-padded", "false");
  await page.getByTestId("photo-crop-dialog").screenshot({
    path: "e2e/__screenshots__/40-crop-before-cannot-zoom-out.png",
  });
});

test("crop: AFTER — zooming out fits the whole horse in the square (41)", async ({ page }) => {
  test.setTimeout(120000);
  await openHorseCrop(page);

  // The bug, stated as an assertion: the slider's floor used to be 1 for every
  // source. On a 2:1 photo it is now 0.5 — the zoom at which the square is the
  // LONGER edge and nothing is cut off.
  const min = Number(await zoom(page).getAttribute("min"));
  expect(min).toBeLessThan(1);
  expect(min).toBeCloseTo(0.5, 2);

  await page.getByTestId("photo-crop-fit").click();

  // Fully zoomed out: the frame is now padded, and the saved square is the
  // source's longer edge (1600, capped to the 1200px max output edge).
  await expect(page.getByTestId("photo-crop-viewport")).toHaveAttribute("data-padded", "true");
  await expect(page.getByTestId("photo-crop-meta")).toContainText("1200×1200");
  await expect(page.getByTestId("photo-crop-meta")).toContainText("saved white");
  await page.getByTestId("photo-crop-dialog").screenshot({
    path: "e2e/__screenshots__/41-crop-after-zoomed-out-to-fit.png",
  });
});

test("crop: AFTER — Apply then Reposition is still pannable and zoomable (42)", async ({ page }) => {
  test.setTimeout(120000);
  await openHorseCrop(page);

  await page.getByTestId("photo-crop-fit").click();
  const applied = await zoom(page).inputValue();
  await page.getByTestId("photo-crop-apply").click();
  await expect(page.getByText("Photo uploaded")).toBeVisible({ timeout: 20000 });

  // The defect: Reposition used to re-open the uploaded SQUARE, which fills the
  // frame at its own floor of zoom 1 and so could not be dragged at all. It now
  // re-opens the original pick, which means the sub-1 range is back...
  await page.getByTestId("horse-photo-reposition").click();
  await expect(page.getByTestId("photo-crop-dialog")).toBeVisible({ timeout: 20000 });

  const reopenedMin = Number(await zoom(page).getAttribute("min"));
  expect(reopenedMin).toBeCloseTo(0.5, 2);
  await expect(page.getByTestId("photo-crop-meta")).toContainText("from a 1600×800 photo");
  // ...and the framing that was applied is restored rather than reset.
  expect(Number(await zoom(page).inputValue())).toBeCloseTo(Number(applied), 2);

  // AC2 says pan AND zoom, so prove the DRAG moves something rather than just
  // reading the slider back. At the fitted zoom a 2:1 source is flush on x, so
  // the slack is vertical — a horizontal drag would legitimately do nothing and
  // would make this assertion a false negative.
  const offsetTop = () =>
    page.evaluate(
      () => document.querySelector<HTMLImageElement>('[data-testid="photo-crop-viewport"] img')!.style.top,
    );
  const before = await offsetTop();
  const box = (await page.getByTestId("photo-crop-viewport").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.7);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.3, { steps: 15 });
  await page.mouse.up();
  expect(await offsetTop()).not.toBe(before);

  await page.getByTestId("photo-crop-dialog").screenshot({
    path: "e2e/__screenshots__/42-crop-reopened-still-interactive.png",
  });
});
