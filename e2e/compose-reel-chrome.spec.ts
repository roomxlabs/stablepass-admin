import { test, expect, type Page } from "@playwright/test";

// ENG-769 screenshot proofs: the reel chrome (overlaid header, ink scrim, no
// label pill / race badge, "Trackwork" reel note) on the preview panel, and
// that a square video or a portrait PHOTO both stay on the classic card.
//
// Its own spec file rather than more cases in compose.spec.ts (ENG-558's
// aspect-ratio evidence) or compose-label.spec.ts (ENG-745's label picker):
// this ticket's evidence is the CHROME, not the aspect-ratio box or the
// picker itself, and mixing it into either would blur what each file proves.
test.describe.configure({ mode: "serial" });

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

/**
 * A single 1080x1920 portrait PNG, drawn in-page (no ffmpeg / no fixtures on
 * disk, and no real client imagery in a PR screenshot) — the same canvas
 * generator pattern compose-multi-photo.spec.ts's numberedPhotos() uses,
 * adapted here to produce ONE portrait tile rather than N landscape ones.
 */
async function portraitPhoto(page: Page, width: number, height: number): Promise<Buffer> {
  const bytes = await page.evaluate(
    async ([w, h]) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#3A5A78";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#FAF7F2";
      ctx.font = "bold 120px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${w}x${h}`, w / 2, h / 2);
      const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), "image/png"));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    },
    [width, height],
  );
  return Buffer.from(bytes);
}

/**
 * Choose the post type in step 2 (ENG-611). The type is now EXPLICIT — the
 * screen no longer infers it from the picked file — so every media test has to
 * select its type before picking a file, or the pick is rejected as a mismatch.
 */
async function chooseType(page: Page, type: "video" | "photo" | "voice" | "text") {
  await page.getByTestId(`type-option-${type}`).click();
  await expect(page.getByTestId(`type-option-${type}`)).toHaveAttribute("data-selected", "true");
}

/** Mock the create-draft BFF call + the browser's direct PUT to the target. */
async function mockUploads(page: Page, type: "video" | "photo" | "voice" | "text") {
  await page.route("**/api/admin/posts", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    // Voice takes the photo path EXACTLY — same bucket, same
    // `<postId>/original` object. Text gets NO upload target at all.
    const storageTarget = {
      id: "p-e2e",
      status: "draft",
      type,
      watermarked: false,
      uploadUrl:
        "http://127.0.0.1:8787/storage/v1/object/upload/sign/post-media/p-e2e/original?token=e2e",
      path: "p-e2e/original",
      token: "e2e",
      bucket: "post-media",
    };
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
            : type === "text"
              ? { id: "p-e2e", status: "draft", type: "text", watermarked: false }
              : storageTarget,
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

/**
 * Open the preview modal at a tall viewport and shoot the PANEL, not the
 * viewport — at a tall media box the card exceeds 90vh and a viewport shot
 * would clip the caption + footnote off the bottom (compose.spec.ts's rule).
 *
 * Returns the panel locator: the modal DUPLICATES every preview testid (the
 * rail's copy is still on the page underneath), so callers must scope their
 * assertions to this locator rather than `page.getByTestId(...)` directly, or
 * a strict-mode query resolves two elements — same trap `settle()` documents.
 */
async function shootPreviewPanel(page: Page, path: string) {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.getByRole("button", { name: "Preview post" }).click();
  await expect(page.getByTestId("preview-modal")).toBeVisible();
  await settle(page, "modal");
  const panel = page.getByTestId("preview-panel");
  await panel.screenshot({ path });
  return panel;
}

test("reel chrome: a 9:16 video shows the overlaid head and the Trackwork reel note", async ({
  page,
}) => {
  test.setTimeout(120000);
  await signIn(page);
  await mockUploads(page, "video");

  await page.goto("/compose");
  await expect(page.getByRole("heading", { name: "Compose post" })).toBeVisible();
  await pickHorseAndCaption(page);
  await chooseType(page, "video");
  await page.getByTestId("label-select").selectOption("Trackwork");

  const bytes = await recordVideo(page, 1080, 1920);
  await page.getByTestId("media-input").setInputFiles({
    name: "reel-9x16.webm",
    mimeType: "video/webm",
    buffer: Buffer.from(bytes),
  });
  await expect(page.getByTestId("upload-done")).toBeVisible({ timeout: 30000 });
  await settle(page);

  const panel = await shootPreviewPanel(page, "e2e/__screenshots__/eng769/01-reel-9x16.png");

  await expect(panel.getByTestId("post-preview")).toHaveAttribute("data-chrome", "reel");
  await expect(panel.getByTestId("preview-reel-head")).toBeVisible();
  await expect(panel.getByTestId("preview-label")).toHaveCount(0);
  await expect(panel.getByTestId("preview-race-badge")).toHaveCount(0);
  await expect(panel.getByTestId("preview-reel-label-note")).toBeVisible();
  await expect(panel.getByTestId("preview-reel-label-note")).toContainText("Trackwork");
});

test("reel chrome: a 0.9 portrait video is still a reel", async ({ page }) => {
  test.setTimeout(120000);
  await signIn(page);
  await mockUploads(page, "video");

  await page.goto("/compose");
  await expect(page.getByRole("heading", { name: "Compose post" })).toBeVisible();
  await pickHorseAndCaption(page);
  await chooseType(page, "video");
  await page.getByTestId("label-select").selectOption("Trackwork");

  const bytes = await recordVideo(page, 900, 1000);
  await page.getByTestId("media-input").setInputFiles({
    name: "reel-0_9.webm",
    mimeType: "video/webm",
    buffer: Buffer.from(bytes),
  });
  await expect(page.getByTestId("upload-done")).toBeVisible({ timeout: 30000 });
  await settle(page);

  const panel = await shootPreviewPanel(page, "e2e/__screenshots__/eng769/02-reel-0_9.png");

  await expect(panel.getByTestId("post-preview")).toHaveAttribute("data-chrome", "reel");
  await expect(panel.getByTestId("preview-reel-head")).toBeVisible();
  await expect(panel.getByTestId("preview-label")).toHaveCount(0);
  await expect(panel.getByTestId("preview-race-badge")).toHaveCount(0);
  await expect(panel.getByTestId("preview-reel-label-note")).toBeVisible();
  await expect(panel.getByTestId("preview-reel-label-note")).toContainText("Trackwork");
});

test("reel chrome: a square video stays on the classic card with a visible label", async ({
  page,
}) => {
  test.setTimeout(120000);
  await signIn(page);
  await mockUploads(page, "video");

  await page.goto("/compose");
  await expect(page.getByRole("heading", { name: "Compose post" })).toBeVisible();
  await pickHorseAndCaption(page);
  await chooseType(page, "video");
  await page.getByTestId("label-select").selectOption("Trackwork");

  const bytes = await recordVideo(page, 1000, 1000);
  await page.getByTestId("media-input").setInputFiles({
    name: "square-classic.webm",
    mimeType: "video/webm",
    buffer: Buffer.from(bytes),
  });
  await expect(page.getByTestId("upload-done")).toBeVisible({ timeout: 30000 });
  await settle(page);

  const panel = await shootPreviewPanel(page, "e2e/__screenshots__/eng769/03-square-classic.png");

  await expect(panel.getByTestId("post-preview")).toHaveAttribute("data-chrome", "classic");
  await expect(panel.getByTestId("preview-reel-head")).toHaveCount(0);
  await expect(panel.getByTestId("preview-label")).toBeVisible();
  await expect(panel.getByTestId("preview-label")).toContainText("Trackwork");
  await expect(panel.getByTestId("preview-reel-label-note")).toHaveCount(0);
});

test("reel chrome: a portrait PHOTO stays on the classic card — reel is video-only", async ({
  page,
}) => {
  test.setTimeout(120000);
  await signIn(page);
  await mockUploads(page, "photo");

  await page.goto("/compose");
  await expect(page.getByRole("heading", { name: "Compose post" })).toBeVisible();
  await pickHorseAndCaption(page);
  await chooseType(page, "photo");
  await page.getByTestId("label-select").selectOption("Trackwork");

  const photo = await portraitPhoto(page, 1080, 1920);
  await page.getByTestId("media-input").setInputFiles({
    name: "portrait-photo.png",
    mimeType: "image/png",
    buffer: photo,
  });
  await expect(page.getByTestId("upload-done")).toBeVisible({ timeout: 15000 });
  await settle(page);

  const panel = await shootPreviewPanel(
    page,
    "e2e/__screenshots__/eng769/04-portrait-photo-classic.png",
  );

  await expect(panel.getByTestId("post-preview")).toHaveAttribute("data-chrome", "classic");
  await expect(panel.getByTestId("preview-reel-head")).toHaveCount(0);
  await expect(panel.getByTestId("preview-label")).toBeVisible();
});
