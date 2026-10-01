import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";

// ENG-1598 — MV-A2: compose + library for multi-video posts.
//
// Against the real compose screen, with the BFF's multi-video routes mocked at
// the browser (the `compose-reel-chrome` `mockUploads` pattern): the create
// route hands back three per-slot Mux targets, the PUTs are held so the
// uploading state can be photographed, and the status poll is scripted from
// "processing" to "ready". Edit mode and the Posts library read the real
// loaders against `e2e/mock-supabase.mjs` (post `ce4`: 2 videos; `p1`: 3).
//
// Fixtures are synthetic (gstreamer `videotestsrc pattern=ball` + a
// "VIDEO-n" label + `timeoverlay`, 4s): two portrait, one LANDSCAPE, so a
// reorder that makes video 3 the cover visibly changes the card's shape.
// Never real client footage. No Mux key is ever read — every Mux-bound call
// is intercepted before it leaves the browser.
test.describe.configure({ mode: "serial" });

const FIX = (n: string) => readFileSync(path.join(__dirname, "fixtures", `multi-video-${n}.webm`));
const SHOTS = "e2e/__screenshots__/eng1598";
const IDS = [
  "00000000-0000-4000-8000-0000000e2a00",
  "00000000-0000-4000-8000-0000000e2a01",
  "00000000-0000-4000-8000-0000000e2a02",
];

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
 * Tall VIEWPORT shots at desktop and phone width, centred on `anchor`. Not
 * `fullPage`: the sticky top bar gets stitched into the middle of a
 * full-page capture (same finding as compose-poster-frame.spec.ts). The wait
 * after each resize outlasts the phone drawer's 220ms slide (ENG-1585).
 */
async function shoot(page: Page, name: string, anchor: string) {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 1400 : 1500 });
    await page.waitForTimeout(400);
    if (width === 390) await expect(page.locator("#admin-sidebar")).toBeHidden({ timeout: 5000 });
    await page
      .getByTestId(anchor)
      .first()
      .evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
    );
    await page.screenshot({ path: `${SHOTS}/${name}-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(400);
}

type Calls = { patches: Record<string, unknown>[]; published: boolean };

async function mockCreateFlow(page: Page) {
  const calls: Calls = { patches: [], published: false };
  const held: Route[] = [];
  let phase: "processing" | "ready" = "processing";

  await page.route("**/api/admin/posts", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON() as { videoCount?: number };
    expect(body.videoCount).toBe(3);
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          id: "mv-e2e",
          status: "draft",
          type: "video",
          watermarked: false,
          uploads: IDS.map((videoId, i) => ({
            videoId,
            uploadUrl: `http://127.0.0.1:8787/mock-upload/mv-e2e-${i}`,
          })),
        },
      }),
    });
  });
  // Held until the test releases them, so "3 tiles uploading" is a real state.
  await page.route("**/mock-upload/**", (route) => {
    held.push(route);
  });
  await page.route("**/api/admin/posts/mv-e2e/videos", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          videos: IDS.map((id, i) => ({
            id,
            sortOrder: i,
            status: phase === "ready" ? "ready" : "uploading",
            posterUrl: null,
            playbackUrl: null,
          })),
        },
      }),
    }),
  );
  await page.route("**/api/admin/posts/mv-e2e", async (route) => {
    if (route.request().method() === "PATCH") calls.patches.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"data":{}}' });
  });
  await page.route("**/api/admin/posts/mv-e2e/publish", async (route) => {
    calls.published = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"data":{}}' });
  });

  return {
    calls,
    release: async () => {
      while (held.length) await held.shift()!.fulfill({ status: 200, body: "" });
    },
    setReady: () => {
      phase = "ready";
    },
    heldCount: () => held.length,
  };
}

test("compose: 3 videos upload in parallel, publish waits for all, reorder moves the cover, preview is a carousel", async ({
  page,
}) => {
  test.setTimeout(180000);
  const bff = await mockCreateFlow(page);
  await signIn(page);
  await page.goto("/compose");
  await page.getByTestId("horse-search").fill("Mah");
  await page.getByTestId("horse-opt-h1").click();
  await page.getByTestId("caption").fill("Three angles from this morning's gallop.");
  await page.getByTestId("type-option-video").click();

  // A 6th pick is refused before anything uploads.
  await page.getByTestId("media-input").setInputFiles(
    ["a", "b", "c", "a", "b", "c"].map((n, i) => ({
      name: `clip-${i + 1}.webm`,
      mimeType: "video/webm",
      buffer: FIX(n),
    })),
  );
  await expect(page.getByTestId("video-error")).toHaveText(
    "You can add up to 5 videos to a post — you picked 6. Nothing was uploaded.",
  );
  await shoot(page, "00-cap-refused", "video-error");

  // PICK — three at once.
  await page.getByTestId("media-input").setInputFiles(
    ["a", "b", "c"].map((n, i) => ({
      name: `gallop-angle-${i + 1}.webm`,
      mimeType: "video/webm",
      buffer: FIX(n),
    })),
  );
  // THREE TILES UPLOADING — all three PUTs are in flight at once (parallel).
  await expect.poll(() => bff.heldCount(), { timeout: 20000 }).toBe(3);
  for (const i of [0, 1, 2]) {
    await expect(page.getByTestId(`video-state-${i}`)).toContainText("uploading");
  }
  await expect(page.getByTestId("topbar-publish")).toBeDisabled();
  await shoot(page, "01-three-uploading", "video-strip");

  // Bytes land → processing; publish still waits, and says why.
  await bff.release();
  for (const i of [0, 1, 2]) {
    await expect(page.getByTestId(`video-state-${i}`)).toHaveText("processing…", { timeout: 20000 });
  }
  await expect(page.getByTestId("video-block-reason")).toHaveText(
    "Waiting for 3 videos to finish processing",
  );
  await expect(page.getByTestId("topbar-publish")).toBeDisabled();
  await shoot(page, "02-processing", "video-strip");

  // Mux finishes → the poll flips every tile → publish enables.
  bff.setReady();
  for (const i of [0, 1, 2]) {
    await expect(page.getByTestId(`video-state-${i}`)).toHaveText("ready", { timeout: 20000 });
  }
  await expect(page.getByTestId("topbar-publish")).toBeEnabled();
  await expect(page.getByTestId("poster-scrubber")).toBeVisible();
  await shoot(page, "03-all-ready", "video-strip");

  // REORDER 3 → 1: the landscape clip becomes the cover; the scrubber and the
  // preview's first slide follow it.
  const scrubSrcBefore = await page.getByTestId("poster-scrubber-video").getAttribute("src");
  await page.getByTestId("video-up-2").click();
  await page.getByTestId("video-up-1").click();
  await expect(page.getByTestId("video-tile-0")).toHaveAttribute("data-video-id", IDS[2]);
  const scrubSrcAfter = await page.getByTestId("poster-scrubber-video").getAttribute("src");
  expect(scrubSrcAfter).not.toBe(scrubSrcBefore);
  await expect(page.getByTestId("preview-video").first()).toHaveAttribute("src", scrubSrcAfter!);
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-testid="preview-video"]') as HTMLVideoElement | null;
    return !!v && v.videoWidth === 640 && v.readyState >= 2;
  });
  await shoot(page, "04-reordered", "video-strip");

  // PREVIEW CAROUSEL — dots + n/m, the same pager as photos.
  const rail = page.getByTestId("post-preview").first();
  await expect(rail.getByTestId("preview-count")).toHaveText("1/3");
  await rail.scrollIntoViewIfNeeded();
  await rail.screenshot({ path: `${SHOTS}/05-preview-slide-1.png` });
  await rail.getByTestId("preview-dot-1").click();
  await expect(rail.getByTestId("preview-count")).toHaveText("2/3");
  await rail.screenshot({ path: `${SHOTS}/06-preview-slide-2.png` });
  await shoot(page, "07-preview-carousel", "post-preview");

  // REMOVE a tile: it disappears and the post keeps working.
  await page.getByTestId("video-remove-2").click();
  await expect(page.getByTestId(/^video-tile-\d+$/)).toHaveCount(2);
  await expect(page.getByTestId("topbar-publish")).toBeEnabled();

  // Publish: ONE PATCH carries the new order without the removed video.
  await page.getByTestId("topbar-publish").click();
  await expect.poll(() => bff.calls.published, { timeout: 20000 }).toBe(true);
  expect(bff.calls.patches[0]).toMatchObject({
    videos: [IDS[2], IDS[0]],
    knownVideos: IDS,
  });
});

test("edit a published 2-video post: add a 3rd, it processes then is ready, and saving keeps all three", async ({
  page,
}) => {
  test.setTimeout(180000);
  const NEW_ID = "00000000-0000-4000-8000-0000000004a2";
  const EXISTING = ["00000000-0000-4000-8000-0000000004a0", "00000000-0000-4000-8000-0000000004a1"];
  let phase: "uploading" | "ready" = "uploading";
  const patches: Record<string, unknown>[] = [];

  await page.route("**/api/admin/posts/ce4/video-uploads", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ count: 1 });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        data: { uploads: [{ videoId: NEW_ID, uploadUrl: "http://127.0.0.1:8787/mock-upload/ce4-2" }] },
      }),
    });
  });
  await page.route("**/mock-upload/**", (route) => route.fulfill({ status: 200, body: "" }));
  await page.route("**/api/admin/posts/ce4/videos", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          videos: [...EXISTING, NEW_ID].map((id, i) => ({
            id,
            sortOrder: i,
            status: id === NEW_ID ? phase : "ready",
            posterUrl: null,
            playbackUrl: null,
          })),
        },
      }),
    }),
  );
  await page.route("**/api/admin/posts/ce4", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    patches.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"data":{}}' });
  });

  await signIn(page);
  await page.goto("/compose?id=ce4");
  await expect(page.getByRole("heading", { name: "Edit post" })).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId(/^video-tile-\d+$/)).toHaveCount(2);
  await shoot(page, "08-edit-two-videos", "video-strip");

  await page.getByTestId("video-add-more").click();
  await page.getByTestId("media-input").setInputFiles({
    name: "gallop-angle-3.webm",
    mimeType: "video/webm",
    buffer: FIX("c"),
  });
  await expect(page.getByTestId("video-state-2")).toHaveText("processing…", { timeout: 20000 });
  await expect(page.getByTestId("video-block-reason")).toHaveText(
    "New videos show to members once they finish processing.",
  );
  await shoot(page, "09-edit-added-processing", "video-strip");

  phase = "ready";
  await expect(page.getByTestId("video-state-2")).toHaveText("ready", { timeout: 20000 });
  await shoot(page, "10-edit-added-ready", "video-strip");

  await page.getByTestId("primary-action").click();
  await expect.poll(() => patches.length, { timeout: 20000 }).toBe(1);
  // Appending already created the row; the order is unchanged, so no `videos`.
  expect(patches[0]).not.toHaveProperty("videos");
});

test("posts library: a multi-video post shows its video count", async ({ page }) => {
  test.setTimeout(120000);
  await signIn(page);
  await page.goto("/posts");
  const badge = page.getByTestId("post-video-count").first();
  await expect(badge).toHaveText("3 videos", { timeout: 30000 });
  await shoot(page, "11-library-video-count", "post-video-count");
});
