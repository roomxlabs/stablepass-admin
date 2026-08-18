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

/**
 * The declarations inside one top-level rule block.
 *
 * Rejects a DUPLICATE selector rather than reading the first and stopping.
 * Reading only the first match is not a guard at all: appending
 * `.postCard { border: 1px solid var(--line); }` to the end of the stylesheet
 * silently undoes this ticket's parity fixes with every test still green,
 * because the later rule is what the cascade actually applies. ENG-611 is
 * sequenced straight after ENG-558 and declares this same stylesheet in its
 * surface, so that is a live hazard, not a hypothetical one.
 */
function rule(selector: string): string {
  const marker = `${selector} {`;
  // Only TOP-LEVEL occurrences count: the selector has to begin its own line.
  // Without that anchor a descendant rule such as `.previewCompact .postCard {`
  // contains `.postCard {` as a substring and reads as a redeclaration, which
  // it is not — it is a different selector at a different specificity, and the
  // compact scale legitimately needs it.
  const hits: number[] = [];
  for (let i = CSS.indexOf(marker); i !== -1; i = CSS.indexOf(marker, i + 1)) {
    if (i === 0 || CSS[i - 1] === "\n") hits.push(i);
  }
  expect(hits.length, `${selector} should be declared exactly once in compose.module.css`).toBe(1);
  return CSS.slice(hits[0], CSS.indexOf("}", hits[0]));
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
