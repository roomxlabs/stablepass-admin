// ENG-247's acceptance criteria are CSS facts: "1-col below 720px", "sticky
// save bar", "chips wrap". Vitest cannot see any of them from a render test —
// `horses.css` is a plain global stylesheet that jsdom never applies, so
// getComputedStyle reports nothing and every rule in this ticket could be
// deleted with the suite fully green. The e2e spec proves them in a real
// browser; this file is the cheap guard that fails in `npm test` the moment a
// rule is dropped or its breakpoint is edited. Same trick as
// app/(dash)/compose/compose-css.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// process.cwd(), not import.meta.url: under Vitest import.meta.url is not a
// file: URL and readFileSync dies with "The URL must be of scheme file".
const CSS = readFileSync(join(process.cwd(), "app/(dash)/horses/horses.css"), "utf8");

/**
 * The body of one `@media (<query>)` block, matched by brace balance so a
 * nested rule cannot truncate it.
 *
 * Asserting the block exists EXACTLY once matters as much as its contents: a
 * second `@media (max-width: 719px)` block appended later would be what the
 * cascade actually applies, and every assertion below would still pass while
 * reading the older, dead copy.
 */
function media(query: string): string {
  const marker = `@media (${query}) {`;
  const hits: number[] = [];
  for (let i = CSS.indexOf(marker); i !== -1; i = CSS.indexOf(marker, i + 1)) {
    hits.push(i);
  }
  expect(hits.length, `@media (${query}) should appear exactly once in horses.css`).toBe(1);

  const start = hits[0] + marker.length;
  let depth = 1;
  for (let i = start; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}") {
      depth--;
      if (depth === 0) return CSS.slice(start, i);
    }
  }
  throw new Error(`unbalanced @media (${query}) block`);
}

/** The declarations of one selector inside a block of CSS text. */
function rule(block: string, selector: string): string {
  const marker = `${selector} {`;
  const at = block.indexOf(marker);
  expect(at, `${selector} should be declared in this block`).toBeGreaterThan(-1);
  return block.slice(at, block.indexOf("}", at));
}

const PHONE = media("max-width: 719px");
const TABLET = media("max-width: 1079px");

describe("horses list — responsive grid (ENG-247)", () => {
  it("keeps the mockup's 4-col grid at desktop widths", () => {
    // The base rule is what >= 1080px renders; this is the "desktop unchanged"
    // half of the acceptance criteria.
    expect(CSS).toMatch(/\.horse-grid-adm \{[^}]*grid-template-columns: repeat\(4, 1fr\)/);
  });

  it("drops to 2 columns between 720 and 1080", () => {
    expect(rule(TABLET, ".horses-screen .horse-grid-adm")).toMatch(
      /grid-template-columns: repeat\(2, 1fr\)/,
    );
  });

  it("drops to a single column below 720", () => {
    expect(rule(PHONE, ".horses-screen .horse-grid-adm")).toMatch(/grid-template-columns: 1fr/);
  });

  it("lets the filter chips wrap and gives the search its own full-width row", () => {
    expect(rule(PHONE, ".horses-screen .adm-filter-bar")).toMatch(/flex-wrap: wrap/);
    // The desktop `.spacer` pushes the 220px-min search right; on a phone it
    // would keep the search pinned to the chip row and force an overflow.
    expect(rule(PHONE, ".horses-screen .adm-filter-bar .spacer")).toMatch(/display: none/);
    expect(rule(PHONE, ".horses-screen .adm-filter-bar .search-mini")).toMatch(/flex: 1 1 100%/);
  });

  it("wraps long names and stat rows instead of widening the card", () => {
    expect(PHONE).toMatch(/overflow-wrap: anywhere/);
    expect(rule(PHONE, ".horses-screen .horse-card-adm .stats")).toMatch(/flex-wrap: wrap/);
  });

  it("gives the chips a 44px tap target", () => {
    expect(rule(PHONE, ".horses-screen .adm-filter-bar .chip")).toMatch(/min-height: 44px/);
  });
});

describe("horse form — 1-col stack and sticky save bar (ENG-247)", () => {
  it("stacks every field grid to one column below 720", () => {
    // One grouped rule covers all three widths (cols-4 is the race-record row).
    const stack = PHONE.slice(PHONE.indexOf(".horse-form .field-grid.cols-2"));
    const decls = stack.slice(0, stack.indexOf("}"));
    for (const n of [2, 3, 4]) expect(decls).toContain(`.horse-form .field-grid.cols-${n}`);
    expect(decls).toMatch(/grid-template-columns: 1fr/);
  });

  it("pins the save bar to the bottom of the VIEWPORT, not the content box", () => {
    // `position: sticky` looks right and silently fails: globals.css gives
    // .admin-content `overflow-x: auto` below 900px, which computes overflow-y
    // to auto and makes it the scrollport — a sticky child would stick to the
    // bottom of the content, off-screen. Only `fixed` is correct here.
    const bar = rule(PHONE, ".horse-form-actions");
    expect(bar).toMatch(/position: fixed/);
    expect(bar).not.toMatch(/position: sticky/);
    expect(bar).toMatch(/bottom: 0/);
    // Epic rule 7: respect the home-indicator inset.
    expect(bar).toMatch(/env\(safe-area-inset-bottom\)/);
    // Above the page, below the nav drawer (100) and its backdrop (90).
    const z = Number(/z-index: (\d+)/.exec(bar)?.[1]);
    expect(z).toBeGreaterThan(30);
    expect(z).toBeLessThan(90);
  });

  it("reserves clearance so the bar never covers the last field or the danger zone", () => {
    expect(rule(PHONE, ".horse-form-body")).toMatch(/padding-bottom: 88px/);
    expect(rule(PHONE, ".horse-form-tail")).toMatch(/padding-bottom: 88px/);
  });

  it("sizes the two bar buttons to the 44px tap target", () => {
    expect(rule(PHONE, ".horse-form-actions .btn")).toMatch(/min-height: 44px/);
  });

  it("keeps the desktop button padding that moved off the inline styles", () => {
    // HorseForm used to carry `style={{ padding: "10px 22px" }}` on both
    // buttons; an inline style beats a media query, so it had to move here.
    // If this rule goes, the desktop form silently changes size.
    expect(CSS).toMatch(/\.horse-form-actions \.btn \{ padding: 10px 22px; \}/);
    // Same story for the empty upload zone's inline `padding: 28`.
    expect(CSS).toMatch(/\.horse-form \.upload-zone:not\(\.filled\) \{ padding: 28px; \}/);
  });
});

/** Every selector inside a block of CSS text, comments stripped. */
function selectorsIn(block: string): string[] {
  // Strip comments first, or their prose is read as selector text. Then take
  // every selector GROUP (the text between one block's `}` and the next `{`)
  // so a multi-line group is checked in full, not just its last line.
  const bare = block.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...bare.matchAll(/(?:^|\})([^{}]+)\{/g)].flatMap((m) =>
    m[1].split(",").map((s) => s.trim()).filter(Boolean),
  );
}

const SCOPED =
  /^(\.horses-screen|\.horse-form|\.horse-form-actions|\.horse-form-body|\.horse-form-tail|\.admin-content\.horse-form-tail|form:has)/;

describe("scoping (this ticket must not reflow sibling screens)", () => {
  // .adm-card-body / .adm-filter-bar / .upload-zone / .form-actions are each
  // duplicated verbatim in posts.css and trainers.css, and an App Router page
  // stylesheet is GLOBAL. An unscoped selector inside ANY responsive block here
  // would reflow ENG-245's and ENG-248's screens from this ticket's file.
  //
  // This walks EVERY `@media` block in the file, not just the phone one. An
  // earlier version checked only the <720px block, which left the 1079px block
  // — this ticket's own surface — completely unguarded, along with any future
  // block someone appends.
  it("scopes every rule in every @media block to the horses screens", () => {
    // Comments first: this file's own prose quotes `@media (max-width: 899px)`
    // when explaining a specificity tie, and a raw scan reads that as a third
    // block.
    const src = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const blocks = [...src.matchAll(/@media \(([^)]+)\) \{/g)].map((m) => {
      const start = m.index! + m[0].length;
      let depth = 1;
      for (let i = start; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) return { query: m[1], body: src.slice(start, i) };
      }
      throw new Error(`unbalanced @media (${m[1]})`);
    });

    expect(blocks.length, "horses.css should declare at least the two ENG-247 breakpoints").toBe(2);

    let checked = 0;
    for (const { query, body } of blocks) {
      for (const sel of selectorsIn(body)) {
        checked++;
        expect(SCOPED.test(sel), `unscoped selector in @media (${query}): "${sel}"`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  // The other half of the hole: a rule added at the TOP level (outside any
  // media query) escapes the walk above entirely. Pin the exact set so a new
  // unscoped `.form-actions { … }` — which would hit trainers — has to be a
  // deliberate edit to this list rather than a silent addition.
  it("adds no new top-level selector beyond the sanctioned set", () => {
    const topLevel = selectorsIn(
      CSS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media \([^)]+\) \{[\s\S]*?\n\}/g, ""),
    );
    const sanctioned = topLevel.filter((s) => SCOPED.test(s)).sort();
    // The three rules ENG-247 added outside a media query, all scoped: they
    // hold desktop values lifted off HorseForm's inline styles.
    expect(sanctioned).toEqual([
      ".horse-form .upload-zone:not(.filled)",
      ".horse-form-actions .btn",
    ]);
    // And nothing this ticket added is an unscoped duplicate of a class the
    // sibling screens also declare.
    for (const shared of [".form-actions", ".upload-zone", ".adm-filter-bar", ".adm-card-body"]) {
      expect(
        topLevel.filter((s) => s === shared).length,
        `${shared} must keep exactly its ONE pre-existing top-level declaration`,
      ).toBeLessThanOrEqual(1);
    }
  });
});
