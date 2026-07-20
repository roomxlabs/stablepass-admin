import { test, expect, type Page } from "@playwright/test";

// Racing match queue screenshot proofs (RF4 / ENG-296), backed by the mock
// Supabase server. /__control flips the dataset so one spec captures both the
// populated queue and the "No pending matches." empty state.
//
// Assertions are on CONTENT, not visibility: a visibility-only check passed
// against 24 empty cards for two epics (see .rx/gotchas.md), so each test
// names fixture values it must find.
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
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("http://127.0.0.1:3002/", { timeout: 30000 });
}

test("match queue renders both proposals side by side (11-racing-matches)", async ({ page }) => {
  test.setTimeout(60000);
  await setEmpty(false);
  await signIn(page);
  await page.goto("/racing-matches");

  const queue = page.getByTestId("match-queue");
  await expect(queue).toBeVisible({ timeout: 30000 });

  // Both seeded proposals, with their real fixture content.
  await expect(page.getByTestId("match-card")).toHaveCount(2);
  await expect(queue).toContainText("Northern Star");
  await expect(queue).toContainText("RA-88213");
  await expect(queue).toContainText("Magic Time");
  await expect(queue).toContainText("RA-90455");

  // The platform side and the feed side both rendered: the second proposal
  // disagrees on the dam, so BOTH values must be on screen. This is the whole
  // point of the screen — if only one source rendered, this fails.
  await expect(queue).toContainText("Illusion"); // StablePass
  await expect(queue).toContainText("Delusion"); // racing feed
  await expect(queue).toContainText("7/7 fields agree");
  await expect(queue).toContainText("4/7 fields agree");

  // Guardrail: no owner PII, no betting identifiers. The p2 fixture seeds real
  // owner/odds keys (including a cased "Owner" that RF1's case-sensitive CHECK
  // would let through), so this assertion has something to actually catch —
  // an empty fixture would make it vacuously green.
  //
  // page.content(), NOT innerText: the RSC flight payload is inlined in
  // <script> tags, and props serialized there are exactly the leak path an
  // innerText check cannot see.
  const html = await page.content();
  for (const marker of [
    "PIILEAKOWNER",
    "PIILEAKCASED",
    "PIILEAKNESTED",
    "PIILEAKODDS",
    "leak@example.com",
  ]) {
    expect(html).not.toContain(marker);
  }
  expect((await page.locator("body").innerText()).toLowerCase()).not.toContain("bookmaker");

  await page.screenshot({ path: "e2e/__screenshots__/11-racing-matches.png", fullPage: true });
});

test("match queue renders the empty state", async ({ page }) => {
  test.setTimeout(60000);
  await setEmpty(true);
  await signIn(page);
  await page.goto("/racing-matches");

  await expect(page.getByTestId("match-empty")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("match-empty")).toContainText("No pending matches.");
  await expect(page.getByTestId("match-card")).toHaveCount(0);

  await page.screenshot({ path: "e2e/__screenshots__/11-racing-matches-empty.png", fullPage: true });
  await setEmpty(false);
});
