import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// ENG-558 — visual proof that the compose preview shows the ratio a MEMBER
// will get, and names it. Deliberately written so it runs UNCHANGED on `main`
// (which has neither the readout nor the real aspect box) — every locator here
// predates this ticket, so the same script produces the "before" set. The
// difference is meant to be visible in the pixels, not in the assertions.
test.describe.configure({ mode: "serial" });

// Absolute override so before/after runs can write to separate directories.
const SHOT_DIR = process.env.ENG558_SHOT_DIR ?? "e2e/__screenshots__/eng558";

function shot(name: string): string {
  mkdirSync(SHOT_DIR, { recursive: true });
  return join(SHOT_DIR, name);
}

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
 * A real, decodable WebM of exactly `width`x`height`, recorded from a canvas in
 * the page. Synthetic on purpose — no client footage goes near a PR — but it is
 * a genuine video file, so `loadedmetadata` reports true intrinsic dimensions
 * exactly as a real upload would.
 */
async function recordVideo(page: Page, width: number, height: number, label: string) {
  const bytes = await page.evaluate(
    async ({ width, height, label }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      const paint = (frame: number) => {
        ctx.fillStyle = "#20303a";
        ctx.fillRect(0, 0, width, height);
        // Corner ticks: make any centre-crop obvious at a glance.
        ctx.fillStyle = "#c9a56f";
        const t = Math.round(Math.min(width, height) * 0.06);
        for (const [x, y] of [
          [0, 0],
          [width - t, 0],
          [0, height - t],
          [width - t, height - t],
        ]) {
          ctx.fillRect(x, y, t, t);
        }
        ctx.fillStyle = "#faf7f2";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `600 ${Math.round(Math.min(width, height) / 9)}px sans-serif`;
        ctx.fillText(label, width / 2, height / 2);
        ctx.fillRect((frame * 29) % width, height - t * 2, t * 2, Math.round(t / 3));
      };

      paint(0);
      const stream = canvas.captureStream(25);
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      const stopped = new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
      });
      rec.start();
      for (let frame = 0; frame < 24; frame++) {
        paint(frame);
        await new Promise((r) => requestAnimationFrame(r));
      }
      rec.stop();
      await stopped;
      const buffer = await new Blob(chunks, { type: "video/webm" }).arrayBuffer();
      return Array.from(new Uint8Array(buffer));
    },
    { width, height, label },
  );

  return Buffer.from(bytes);
}

/**
 * Wait for the browser to actually decode the asset. Without this the shot
 * lands before the object URL paints and the media box photographs empty —
 * the exact defect recorded in .rx/gotchas.md against 06-compose-preview.png.
 */
async function settleMedia(page: Page) {
  await page.waitForFunction(
    () => {
      const v = document.querySelector("video");
      return !!v && v.videoWidth > 0 && v.videoHeight > 0;
    },
    undefined,
    { timeout: 30000 },
  );
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

async function mockUploadRoutes(page: Page) {
  // Create-draft (video branch) → a one-time upload target. The real Mux
  // endpoint is not reachable in e2e; the upload path itself is unchanged by
  // this ticket and is mocked exactly as compose.spec.ts already does.
  await page.route("**/api/admin/posts", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          id: "p-eng558",
          status: "draft",
          type: "video",
          watermarked: false,
          uploadUrl: "http://127.0.0.1:8787/mux-upload/p-eng558",
          muxUploadId: "mux-eng558",
        },
      }),
    });
  });
  await page.route("**/mux-upload/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
}

test("compose preview: landscape vs portrait video", async ({ page }) => {
  test.setTimeout(180000);
  await signIn(page);
  await mockUploadRoutes(page);

  await page.goto("/compose");
  await expect(page.getByRole("heading", { name: "Compose post" })).toBeVisible();
  await page.screenshot({ path: shot("01-compose-empty.png"), fullPage: true });

  await page.getByTestId("horse-search").fill("Mah");
  await page.getByTestId("horse-opt-h1").click();
  await expect(page.getByTestId("byline-select")).toHaveValue("t1");
  await page
    .getByTestId("caption")
    .fill("Last fast gallop before Saturday — he's spot-on. Came home strong over the final 200.");

  // --- Landscape 16:9 -------------------------------------------------------
  await page.getByTestId("media-input").setInputFiles({
    name: "landscape-16x9.webm",
    mimeType: "video/webm",
    buffer: await recordVideo(page, 1920, 1080, "16:9"),
  });
  await expect(page.getByTestId("upload-done")).toBeVisible({ timeout: 30000 });
  await settleMedia(page);
  await page.screenshot({ path: shot("02-compose-landscape.png"), fullPage: true });

  await page.getByRole("button", { name: "Preview on mobile & web" }).click();
  await expect(page.getByTestId("preview-modal")).toBeVisible();
  await settleMedia(page);
  await page.screenshot({ path: shot("03-preview-landscape.png") });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("preview-modal")).toBeHidden();

  // --- Portrait 9:16 — the case the operator currently cannot see -----------
  await page.getByTestId("media-input").setInputFiles({
    name: "portrait-9x16.webm",
    mimeType: "video/webm",
    buffer: await recordVideo(page, 1080, 1920, "9:16"),
  });
  await expect(page.getByTestId("upload-done")).toBeVisible({ timeout: 30000 });
  await settleMedia(page);
  await page.screenshot({ path: shot("04-compose-portrait.png"), fullPage: true });

  await page.getByRole("button", { name: "Preview on mobile & web" }).click();
  await expect(page.getByTestId("preview-modal")).toBeVisible();
  await settleMedia(page);
  await page.screenshot({ path: shot("05-preview-portrait.png") });
});
