import { test, expect, type Page } from "@playwright/test";

// Compose screen (ENG-176 / T6) screenshot proofs, backed by the mock Supabase
// server (horse/trainer fixtures) + browser-level route mocks for the
// direct-upload flow (the real Mux/Storage targets aren't reachable in e2e).
//
// ENG-558 added the landscape/portrait proofs. The whole point of the ticket is
// that an operator could not tell a 9:16 reel would be cropped, so the evidence
// has to be a REAL file with REAL intrinsic dimensions — a 1x1 placeholder
// proves nothing about aspect.
test.describe.configure({ mode: "serial" });

// 1x1 PNG — enough for the object-URL <img> preview to render a filled zone.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

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

/**
 * Record a synthetic webm at exact dimensions, in-page, via canvas
 * captureStream + MediaRecorder. There is no ffmpeg on the build box, and real
 * client footage must never reach a PR screenshot. The <video> reports true
 * intrinsic dimensions from the result, which is what the readout prints.
 *
 * Corner ticks + a centre cross make a centre-crop self-evident in the shot.
 */
async function recordVideo(page: Page, width: number, height: number): Promise<number[]> {
  return page.evaluate(
    async ([w, h]) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;

      const paint = (i: number) => {
        ctx.fillStyle = "#285D50";
        ctx.fillRect(0, 0, w, h);
        // Corner ticks: if these are missing from the preview, it was cropped.
        ctx.fillStyle = "#F1ECE3";
        const t = Math.round(Math.min(w, h) * 0.09);
        for (const [x, y] of [
          [0, 0],
          [w - t, 0],
          [0, h - t],
          [w - t, h - t],
        ]) {
          ctx.fillRect(x, y, t, t);
        }
        // Centre cross + a moving dot so the frames actually differ.
        ctx.strokeStyle = "#F1ECE3";
        ctx.lineWidth = Math.max(2, Math.round(Math.min(w, h) * 0.006));
        ctx.beginPath();
        ctx.moveTo(w / 2, 0);
        ctx.lineTo(w / 2, h);
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();
        ctx.fillStyle = "#C9A227";
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, t * (0.4 + 0.1 * Math.sin(i / 3)), 0, Math.PI * 2);
        ctx.fill();
        // Label the true size, so the screenshot is self-describing.
        ctx.fillStyle = "#F1ECE3";
        ctx.font = `${Math.round(Math.min(w, h) * 0.07)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(`${w}x${h}`, w / 2, h / 2 - t);
      };

      const stream = canvas.captureStream(25);
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
      rec.ondataavailable = (e) => chunks.push(e.data);
      const done = new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
      });
      rec.start();
      for (let i = 0; i < 24; i++) {
        paint(i);
        await new Promise((r) => requestAnimationFrame(r));
      }
      rec.stop();
      await done;
      const buf = await new Blob(chunks, { type: "video/webm" }).arrayBuffer();
      return Array.from(new Uint8Array(buf));
    },
    [width, height],
  );
}

/** Mock the create-draft BFF call + the browser's direct PUT to the target. */
async function mockUploads(page: Page, type: "video" | "photo") {
  await page.route("**/api/admin/posts", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        data:
          type === "video"
            ? {
                id: "p-e2e",
                status: "draft",
                type: "video",
                watermarked: false,
                // Not a real Mux URL: the guardrail is that admin never
                // constructs or logs one, so e2e points at the local mock.
                uploadUrl: "http://127.0.0.1:8787/mock-upload/p-e2e",
                muxUploadId: "up-e2e",
              }
            : {
                id: "p-e2e",
                status: "draft",
                type: "photo",
                watermarked: false,
                uploadUrl:
                  "http://127.0.0.1:8787/storage/v1/object/upload/sign/post-media/p-e2e/original?token=e2e",
                path: "p-e2e/original",
                token: "e2e",
                bucket: "post-media",
              },
      }),
    });
  });

  await page.route("**/mock-upload/**", (route) => route.fulfill({ status: 200, body: "" }));
  await page.route("**/storage/v1/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ Key: "post-media/p-e2e/original" }),
    }),
  );
}

/**
 * Wait for the preview to actually PAINT before shooting. The committed
 * 06-compose-preview baseline was captured before its blob-URL media decoded,
 * so it showed the empty media ground instead of the file — misleading
 * evidence, and it reproduces deterministically under `next start`.
 */
async function settle(page: Page, where: "rail" | "modal" = "rail") {
  // Scope matters: the modal DUPLICATES every preview testid, and the rail's
  // copy comes first in DOM order and is already decoded. An unscoped
  // querySelector therefore returns the rail and resolves instantly, silently
  // reintroducing the "shot before the media decoded" flake this kills.
  const scope = where === "modal" ? '[data-testid="preview-panel"] ' : "";
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const img = el.querySelector("img");
      if (img) return img.complete && img.naturalWidth > 0;
      const video = el.querySelector("video");
      return !!video && video.videoWidth > 0;
    },
    `${scope}[data-testid="preview-media"]`,
    { timeout: 20000 },
  );
  // Two frames: one to lay out at the new aspect, one to paint it.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );
}

async function pickHorseAndCaption(page: Page) {
  await page.getByTestId("horse-search").fill("Mah");
  await page.getByTestId("horse-opt-h1").click();
  await expect(page.getByTestId("byline-select")).toHaveValue("t1");
  await page
    .getByTestId("caption")
    .fill("Last fast gallop before Saturday — he's spot-on. Came home strong over the final 200.");
}

test("compose: pick horse, upload photo, caption, preview", async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page);
  await mockUploads(page, "photo");

  await page.goto("/compose");
  await expect(page.getByRole("heading", { name: "Compose post" })).toBeVisible();
  await page.screenshot({ path: "e2e/__screenshots__/04-compose-empty.png", fullPage: true });

  await pickHorseAndCaption(page);

  await page.getByTestId("media-input").setInputFiles({
    name: "gallop.jpg",
    mimeType: "image/jpeg",
    buffer: PNG_1x1,
  });
  await expect(page.getByTestId("upload-done")).toBeVisible({ timeout: 15000 });
  await settle(page);

  await page.screenshot({ path: "e2e/__screenshots__/05-compose-filled.png", fullPage: true });

  // Taller viewport for the modal shot: the panel caps at 90vh and scrolls, so
  // a short viewport would clip the caption + footnote out of the evidence.
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.getByRole("button", { name: "Preview post" }).click();
  await expect(page.getByTestId("preview-modal")).toBeVisible();
  await settle(page, "modal");
  // Shoot the PANEL, not the viewport: at a tall media box the card exceeds
  // 90vh and a viewport shot would clip the caption + footnote off the bottom.
  await page
    .getByTestId("preview-panel")
    .screenshot({ path: "e2e/__screenshots__/06-compose-preview.png" });
});

// ENG-558: the two cases the operator could not previously tell apart.
for (const shape of [
  { name: "landscape", width: 1920, height: 1080, slot: "07" },
  { name: "portrait", width: 1080, height: 1920, slot: "08" },
] as const) {
  test(`compose: a ${shape.name} file previews at its real aspect with a readout`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    await signIn(page);
    await mockUploads(page, "video");

    await page.goto("/compose");
    await expect(page.getByRole("heading", { name: "Compose post" })).toBeVisible();
    await pickHorseAndCaption(page);

    const bytes = await recordVideo(page, shape.width, shape.height);
    await page.getByTestId("media-input").setInputFiles({
      name: `${shape.name}.webm`,
      mimeType: "video/webm",
      buffer: Buffer.from(bytes),
    });
    await expect(page.getByTestId("upload-done")).toBeVisible({ timeout: 30000 });
    await settle(page);

    // The readout names what was detected and what members will get.
    const readout = page.getByTestId("preview-readout");
    await expect(readout).toContainText(`${shape.width}×${shape.height}`);
    await expect(readout).toContainText(shape.name === "landscape" ? "Landscape" : "Portrait");
    if (shape.name === "portrait") {
      // The single most important case: it is the one the operator cannot see.
      await expect(readout).toContainText("cropped to 4:5");
    }

    await page.screenshot({
      path: `e2e/__screenshots__/${shape.slot}-compose-${shape.name}.png`,
      fullPage: true,
    });

    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.getByRole("button", { name: "Preview post" }).click();
    await expect(page.getByTestId("preview-modal")).toBeVisible();
    await settle(page, "modal");
    await page
      .getByTestId("preview-panel")
      .screenshot({ path: `e2e/__screenshots__/${shape.slot}-compose-${shape.name}-modal.png` });
  });
}
