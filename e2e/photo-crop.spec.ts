import { test, expect, type Page } from "@playwright/test";

// ENG-749 — profile photo crop, on both HorseForm and TrainerForm.
//
// The evidence has to show that the STORED bytes changed, not merely that a
// dialog opened, so these specs upload a photo through the real client path and
// screenshot the resulting preview, which the mock Supabase now serves back
// from its in-memory object store.
//
// The test image is generated in-page with a canvas rather than committed. Real
// client photos must never reach a PR screenshot (see .rx/gotchas.md, ENG-558),
// and a synthetic subject deliberately placed OFF-CENTRE is what makes the
// before/after legible: a centre crop misses it, which is exactly Mel's report.
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
 * Draw a 1600x800 landscape photo whose subject sits in the right-hand third,
 * then hand it to the form's file input as a real File through a change event —
 * the same route a browser file pick takes.
 */
async function pickWidePhoto(page: Page) {
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 800;
    const ctx = canvas.getContext("2d")!;

    // Striped ground, so panning is visibly a pan and not a re-render.
    const bg = ctx.createLinearGradient(0, 0, 1600, 800);
    bg.addColorStop(0, "#122E26");
    bg.addColorStop(1, "#285D50");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 1600, 800);
    ctx.fillStyle = "rgba(250,247,242,0.06)";
    for (let x = 0; x < 1600; x += 80) ctx.fillRect(x, 0, 40, 800);

    // The subject: far right of frame, which a centre crop cuts in half.
    ctx.fillStyle = "#C9A56F";
    ctx.beginPath();
    ctx.arc(1300, 400, 190, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#122E26";
    ctx.beginPath();
    ctx.arc(1240, 350, 30, 0, Math.PI * 2);
    ctx.arc(1360, 350, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#122E26";
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.arc(1300, 430, 80, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();

    ctx.fillStyle = "#FAF7F2";
    ctx.font = "600 44px Inter, sans-serif";
    ctx.fillText("SUBJECT →", 900, 700);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92),
    );
    const file = new File([blob!], "wide-subject.jpg", { type: "image/jpeg" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** Wait for the stored photo to come back from the mock and actually decode. */
async function waitForPreview(page: Page) {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const img = document.querySelector<HTMLImageElement>(".preview img");
          return img?.naturalWidth ?? 0;
        }),
      { timeout: 20000 },
    )
    .toBeGreaterThan(0);
}

/**
 * What the stored object ACTUALLY is: its key, and the Content-Type the server
 * serves it with.
 *
 * This is the only place in the repo that observes either. supabase-js sends a
 * Blob body as multipart FormData and the part's own type becomes the stored
 * MIME — the `contentType` upload OPTION is ignored for Blob bodies
 * (storage-js `uploadOrUpdate`), so asserting that option would prove nothing
 * about the wire. Reading it back through the same signed URL the <img> uses
 * is what closes that gap.
 */
async function storedObject(page: Page): Promise<{ src: string; contentType: string | null }> {
  return page.evaluate(async () => {
    const img = document.querySelector<HTMLImageElement>(".preview img")!;
    const res = await fetch(img.src);
    return { src: img.src, contentType: res.headers.get("content-type") };
  });
}

/** Drag the photo left, which moves the crop window right onto the subject. */
async function dragOntoSubject(page: Page) {
  const viewport = page.getByTestId("photo-crop-viewport");
  const box = (await viewport.boundingBox())!;
  const midY = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.75, midY);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, midY, { steps: 20 });
  await page.mouse.up();
}

test("trainer: the crop step opens with the subject off-centre (29)", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await page.goto("/trainers/new");
  await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });

  await pickWidePhoto(page);
  await expect(page.getByTestId("photo-crop-dialog")).toBeVisible({ timeout: 20000 });
  // The default is a centre crop — the old behaviour, and the bug Mel reported:
  // the circle shows background while the subject sits outside it.
  await expect(page.getByTestId("photo-crop-meta")).toContainText("from a 1600×800 photo");
  await page.getByTestId("photo-crop-dialog").screenshot({
    path: "e2e/__screenshots__/29-trainer-crop-step-off-centre.png",
  });
});

test("trainer: BEFORE — Use as-is stores the raw wide photo (30)", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await page.goto("/trainers/new");
  await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });

  await pickWidePhoto(page);
  await expect(page.getByTestId("photo-crop-dialog")).toBeVisible({ timeout: 20000 });
  await page.getByTestId("photo-crop-use-as-is").click();

  await expect(page.getByText("Photo added")).toBeVisible({ timeout: 20000 });
  await waitForPreview(page);
  // The stored object is the untouched 1600x800 original: this is exactly what
  // every trainer photo looked like before this ticket.
  expect(
    await page.evaluate(
      () => document.querySelector<HTMLImageElement>(".preview img")!.naturalWidth,
    ),
  ).toBe(1600);
  const object = await storedObject(page);
  expect(object.contentType).toBe("image/jpeg");
  expect(object.src).toMatch(/\.jpg\?/);

  await page.screenshot({
    path: "e2e/__screenshots__/30-trainer-photo-as-is-before.png",
    fullPage: true,
  });
});

test("trainer: AFTER — dragging onto the subject stores a square crop (31, 32)", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await page.goto("/trainers/new");
  await expect(page.getByTestId("trainer-form")).toBeVisible({ timeout: 30000 });

  await pickWidePhoto(page);
  await expect(page.getByTestId("photo-crop-dialog")).toBeVisible({ timeout: 20000 });
  await dragOntoSubject(page);
  await page.getByTestId("photo-crop-dialog").screenshot({
    path: "e2e/__screenshots__/31-trainer-crop-step-repositioned.png",
  });

  await page.getByTestId("photo-crop-apply").click();
  await expect(page.getByText("Photo added")).toBeVisible({ timeout: 20000 });
  await waitForPreview(page);

  // The stored object is now SQUARE, and capped at the 1200px max edge. Proving
  // this from the decoded image is the assertion that a renamed-but-uncropped
  // upload could not fake.
  const stored = await page.evaluate(() => {
    const img = document.querySelector<HTMLImageElement>(".preview img")!;
    return { w: img.naturalWidth, h: img.naturalHeight };
  });
  expect(stored.w).toBe(stored.h);
  expect(stored.w).toBe(800);

  // The key and the bytes must agree: a JPEG source crops to JPEG, so the
  // object is served as image/jpeg from a .jpg key. ENG-766's marketing copy
  // derives the PUBLIC object's key from this one, so a disagreement here is
  // what would put mislabelled bytes on a public origin.
  const object = await storedObject(page);
  expect(object.contentType).toBe("image/jpeg");
  expect(object.src).toMatch(/\.jpg\?/);

  await page.screenshot({
    path: "e2e/__screenshots__/32-trainer-photo-cropped-after.png",
    fullPage: true,
  });
});

test("horse: the crop step opens and stores a square crop (33, 34)", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await page.goto("/horses/new");
  await expect(page.getByRole("button", { name: "Add to library" }).first()).toBeVisible({
    timeout: 30000,
  });

  await pickWidePhoto(page);
  await expect(page.getByTestId("photo-crop-dialog")).toBeVisible({ timeout: 20000 });
  await dragOntoSubject(page);
  await page.getByTestId("photo-crop-dialog").screenshot({
    path: "e2e/__screenshots__/33-horse-crop-step.png",
  });

  await page.getByTestId("photo-crop-apply").click();
  await expect(page.getByText("Photo uploaded")).toBeVisible({ timeout: 20000 });
  await waitForPreview(page);

  const stored = await page.evaluate(() => {
    const img = document.querySelector<HTMLImageElement>(".preview img")!;
    return { w: img.naturalWidth, h: img.naturalHeight };
  });
  expect(stored.w).toBe(stored.h);

  const object = await storedObject(page);
  expect(object.contentType).toBe("image/jpeg");
  expect(object.src).toMatch(/\.jpg\?/);

  await page.screenshot({
    path: "e2e/__screenshots__/34-horse-photo-cropped.png",
    fullPage: true,
  });
});
