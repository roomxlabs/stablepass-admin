import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

// ENG-1584 — "the choose preview frame in admin doesn't work" (client, 28 Sep).
//
// Two halves, both proven here against the real compose screen:
//   1. After "Use this frame" the right-hand preview parks on THAT frame. It
//      used to sit on frame 0 whatever was picked.
//   2. Publishing a post with a picked frame calls the poster re-bake route at
//      that time — the Mux `asset.ready` webhook has usually already baked the
//      default frame by then, and its null guard means it never bakes again.
//
// The fixture is synthetic (gstreamer `videotestsrc pattern=ball` +
// `timeoverlay`, 360x640, 8s): every frame prints its own timestamp, so the
// before/after shots are self-describing. Never real client footage. A
// MediaRecorder webm (compose.spec.ts's trick) is useless here: it has no
// duration, so the scrubber never enables.
test.describe.configure({ mode: "serial" });

const FIXTURE = readFileSync(path.join(__dirname, "fixtures", "poster-frame.webm"));
const SHOTS = "e2e/__screenshots__/eng1584";

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

type Calls = { patches: unknown[]; rebakes: unknown[]; published: boolean };

async function mockBff(page: Page): Promise<Calls> {
  const calls: Calls = { patches: [], rebakes: [], published: false };
  await page.route("**/api/admin/posts", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          id: "p-e2e",
          status: "draft",
          type: "video",
          watermarked: false,
          uploadUrl: "http://127.0.0.1:8787/mock-upload/p-e2e",
          muxUploadId: "up-e2e",
        },
      }),
    });
  });
  await page.route("**/mock-upload/**", (route) => route.fulfill({ status: 200, body: "" }));
  await page.route("**/api/admin/posts/p-e2e", async (route) => {
    if (route.request().method() === "PATCH") calls.patches.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"data":{}}' });
  });
  await page.route("**/api/admin/posts/p-e2e/poster", async (route) => {
    calls.rebakes.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { posterUrl: "posters/p-e2e/1.jpg", posterTimeS: 0, posterDisplayUrl: null },
      }),
    });
  });
  await page.route("**/api/admin/posts/p-e2e/publish", async (route) => {
    calls.published = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"data":{}}' });
  });
  return calls;
}

/** The rail preview's <video>, once it has decoded a frame. */
async function previewTime(page: Page): Promise<number> {
  return page.evaluate(() => {
    const v = document.querySelector('[data-testid="preview-video"]') as HTMLVideoElement | null;
    return v ? v.currentTime : -1;
  });
}

async function twoFrames(page: Page) {
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );
}

test("compose: Use this frame moves the preview to the picked frame, and publish bakes it", async ({
  page,
}) => {
  test.setTimeout(120000);
  const calls = await mockBff(page);
  await signIn(page);
  await page.goto("/compose");

  await page.getByTestId("horse-search").fill("Mah");
  await page.getByTestId("horse-opt-h1").click();
  await page.getByTestId("caption").fill("Picked frame, not frame 0.");
  await page.getByTestId("type-option-video").click();

  await page.getByTestId("media-input").setInputFiles({
    name: "poster-frame.webm",
    mimeType: "video/webm",
    buffer: FIXTURE,
  });
  await expect(page.getByTestId("upload-done")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("poster-use-frame")).toBeEnabled({ timeout: 20000 });
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-testid="preview-video"]') as HTMLVideoElement | null;
    return !!v && v.videoWidth > 0 && v.readyState >= 2;
  });
  await twoFrames(page);

  // BEFORE: the preview sits on the opening frame.
  expect(await previewTime(page)).toBeLessThan(0.1);
  // Viewport shots, not a full-element one: the sticky page header gets
  // stitched into the middle of a tall element screenshot.
  const workspace = {
    screenshot: async (o: { path: string }) => {
      await page.getByTestId("poster-scrubber").scrollIntoViewIfNeeded();
      await page.screenshot({ path: o.path });
    },
  };
  await workspace.screenshot({ path: `${SHOTS}/01-before-pick.png` });
  await page.getByTestId("post-preview").first().screenshot({ path: `${SHOTS}/03-preview-before-pick.png` });

  // Scrub to ~6s and pick it.
  await page.getByTestId("poster-scrubber-range").fill("6");
  await expect(page.getByTestId("poster-scrub-meta")).toContainText("6.00s");
  await page.getByTestId("poster-use-frame").click();
  await expect(page.getByTestId("poster-time-picked")).toContainText("6.00s");

  // AFTER: the preview has moved to the picked frame, without playing.
  await expect(page.getByTestId("preview-video")).toHaveAttribute("data-poster-time", /^6(\.0+)?$/);
  await expect.poll(() => previewTime(page)).toBeGreaterThan(5.9);
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-testid="preview-video"]') as HTMLVideoElement | null;
    return !!v && !v.seeking && v.paused;
  });
  await twoFrames(page);
  await workspace.screenshot({ path: `${SHOTS}/02-after-pick.png` });
  await page.getByTestId("post-preview").first().screenshot({ path: `${SHOTS}/04-preview-after-pick.png` });

  // Publish → the chosen time is stored AND baked.
  await page.getByTestId("primary-action").click();
  await expect.poll(() => calls.published, { timeout: 20000 }).toBe(true);
  expect(calls.patches).toContainEqual(expect.objectContaining({ poster_time_s: 6 }));
  expect(calls.rebakes).toEqual([{ time: 6 }]);
});
