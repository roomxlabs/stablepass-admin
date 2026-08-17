// ENG-558's card-parity acceptance criteria are CSS facts ("no border", "sans",
// "no brand green behind media"). Vitest stubs CSS modules — `styles.postCard`
// is just the string "postCard" and getComputedStyle sees nothing — so a render
// test can NEVER prove any of them; all four could be reverted with the suite
// green. Read the stylesheet and assert on the rule text instead.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// process.cwd(), not import.meta.url: under Vitest import.meta.url is not a
// file: URL and readFileSync dies with "The URL must be of scheme file".
const CSS = readFileSync(join(process.cwd(), "app/(dash)/compose/compose.module.css"), "utf8");

/** The declarations inside one top-level rule block. */
function rule(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `${selector} should exist in compose.module.css`).toBeGreaterThan(-1);
  return CSS.slice(at, CSS.indexOf("}", at));
}

describe("member-card parity (ENG-554 geometry)", () => {
  it("gives the preview card no border", () => {
    expect(rule(".postCard")).toMatch(/border:\s*none/);
    expect(rule(".postCard")).not.toMatch(/border:\s*1px/);
  });

  it("runs the media flush to the card edges", () => {
    // The card has zero HORIZONTAL padding; the gutter lives on the children,
    // which is what lets the media box reach both edges.
    expect(rule(".postCard")).toMatch(/padding:\s*18px\s+0/);
    expect(rule(".postHead")).toMatch(/margin:\s*0\s+18px/);
    expect(rule(".postBody")).toMatch(/margin:\s*12px\s+18px\s+0/);
    // ...and the media itself carries no horizontal margin or padding.
    expect(rule(".postMedia")).not.toMatch(/margin-(left|right)/);
    expect(rule(".postMedia")).not.toMatch(/padding/);
  });

  it("puts a neutral ground behind unpainted media, never brand green", () => {
    expect(rule(".postMedia")).not.toContain("--brand-green-dark");
    expect(rule(".postMedia")).toMatch(/background:\s*#1a1a1a/i);
  });

  it("keeps 16/10 as the CSS fallback so the box is never 0-height", () => {
    expect(rule(".postMedia")).toMatch(/aspect-ratio:\s*16\s*\/\s*10/);
    expect(rule(".postMedia")).not.toMatch(/aspect-ratio:\s*16\s*\/\s*9/);
  });
});

describe("option D typography on the horse name", () => {
  it("is Inter 500 on #3A3A38, not Cormorant", () => {
    const postHorse = rule(".postHorse");
    expect(postHorse).toMatch(/font-family:\s*var\(--font-sans\)/);
    expect(postHorse).toMatch(/font-weight:\s*500/);
    expect(postHorse).toMatch(/color:\s*#3a3a38/i);
    expect(postHorse).not.toContain("--font-serif");
  });
});

describe("the reaction bar exists as a styled row", () => {
  it("ships .postActions with the bookmark pushed to the far edge", () => {
    expect(rule(".postActions")).toMatch(/display:\s*flex/);
    expect(rule(".postActionSpacer")).toMatch(/flex:\s*1/);
  });
});

describe("the fake web pane is gone from the stylesheet too", () => {
  it("drops the device-frame rules the two-pane modal needed", () => {
    for (const dead of [
      ".frames {",
      ".frameLabel {",
      ".phone {",
      ".phoneScreen {",
      ".web {",
      ".webChrome {",
      ".webDots {",
      ".webUrl {",
      ".webScreen {",
    ]) {
      expect(CSS, `${dead} should have been deleted with the web pane`).not.toContain(dead);
    }
  });

  it("drops the hand-rolled mini card that duplicated the member card", () => {
    for (const dead of [".miniCard {", ".miniHead {", ".miniMedia {", ".miniBody {"]) {
      expect(CSS, `${dead} should have been replaced by <PostPreview compact>`).not.toContain(dead);
    }
  });
});
