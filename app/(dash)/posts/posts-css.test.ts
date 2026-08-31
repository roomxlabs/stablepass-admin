// ENG-245's acceptance is a set of CSS facts: below 720px the table stops being
// a table, the filter chips wrap, and the mini search goes full-width. Vitest
// stubs stylesheets — jsdom's getComputedStyle sees none of this — so a render
// test can never prove any of it, and every rule below could be deleted with
// the suite green. Read the stylesheet and assert on the rule text instead
// (the precedent is compose-css.test.ts, ENG-558).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// process.cwd(), not import.meta.url: under Vitest import.meta.url is not a
// file: URL and readFileSync dies with "The URL must be of scheme file".
const CSS = readFileSync(join(process.cwd(), "app/(dash)/posts/posts.css"), "utf8");

// The mobile block, isolated. Everything ENG-245 adds lives inside it, so
// asserting against this slice also proves a rule is not leaking to desktop.
const MEDIA_OPEN = "@media (max-width: 719px) {";
function mobileBlock(): string {
  const start = CSS.indexOf(MEDIA_OPEN);
  expect(start, "posts.css must declare the 720px content-stacking breakpoint").toBeGreaterThan(-1);
  // Balance braces from the media query's own `{` to find its close.
  let depth = 0;
  for (let i = start + MEDIA_OPEN.length - 1; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}" && --depth === 0) return CSS.slice(start, i + 1);
  }
  throw new Error("unterminated @media block in posts.css");
}
const MOBILE = mobileBlock();

/** Byte offsets of every occurrence of `selector {` that STARTS a line. */
function ownLineHits(selector: string, source: string): number[] {
  const marker = `${selector} {`;
  const hits: number[] = [];
  for (let i = source.indexOf(marker); i !== -1; i = source.indexOf(marker, i + 1)) {
    // Anchor on newline + indentation, not the line start: rules inside the
    // media block are indented. It also keeps a descendant selector such as
    // `.adm-table td.actions button {` from reading as a redeclaration of
    // `.adm-table td.actions {`.
    if (/(^|\n)[ \t]*$/.test(source.slice(0, i))) hits.push(i);
  }
  return hits;
}

/**
 * The declarations inside one rule block.
 *
 * Rejects a duplicate WITHIN the scope, and — because a later redeclaration is
 * what the cascade actually applies — also checks that the block being read is
 * the LAST own-line declaration of that selector in the whole stylesheet. Most
 * of these selectors legitimately appear twice (a desktop rule plus its mobile
 * override), so "exactly once in the file" would be wrong; "nothing overrides
 * it later" is the property that matters, and it catches an override appended
 * after the media block. Pass `winsCascade: false` when deliberately reading an
 * earlier declaration (the desktop half of `.cell-label`).
 *
 * Know its limits: this compares rule TEXT, so it cannot see a duplicate that
 * arrives as one selector in a comma list (`.adm-table th, .adm-table td.nowrap {`)
 * or under a different, higher-specificity selector (`.adm-table tbody td.nowrap`).
 * Those still need the e2e layout assertions to catch them.
 */
function rule(selector: string, source = MOBILE, winsCascade = true): string {
  const hits = ownLineHits(selector, source);
  expect(hits.length, `${selector} should be declared exactly once in this scope`).toBe(1);
  if (winsCascade) {
    const all = ownLineHits(selector, CSS);
    const offset = CSS.indexOf(source);
    expect(
      all[all.length - 1],
      `nothing may redeclare ${selector} after the block under test`,
    ).toBe(offset + hits[0]);
  }
  return source.slice(hits[0], source.indexOf("}", hits[0]));
}

describe("posts.css — the <720px card transform (ENG-245)", () => {
  it("stacks the table into cards: no header, no table display", () => {
    expect(rule(".adm-table thead")).toMatch(/display:\s*none/);
    // The group rule that de-tables the table, tbody, rows and cells.
    expect(MOBILE).toMatch(
      /\.adm-table,\s*\n\s*\.adm-table tbody,\s*\n\s*\.adm-table tr,\s*\n\s*\.adm-table td\s*\{\s*display:\s*block/,
    );
  });

  it("lays each row out as a bordered, rounded card", () => {
    const card = rule(".adm-table tbody tr.row-link");
    expect(card).toMatch(/display:\s*grid/);
    expect(card).toMatch(/border:\s*1px solid var\(--line\)/);
    expect(card).toMatch(/border-radius:\s*12px/);
  });

  it("drops the column nowrap so long text wraps inside the card", () => {
    expect(rule(".adm-table td.nowrap")).toMatch(/white-space:\s*normal/);
  });

  it("clamps long titles and excerpts rather than letting them overflow", () => {
    const clamp = rule(".adm-table td .row-name,\n  .adm-table td .row-sub");
    expect(clamp).toMatch(/-webkit-line-clamp:\s*2/);
    expect(clamp).toMatch(/overflow:\s*hidden/);
    expect(clamp).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("wraps the status chips and gives them a 44px tap target", () => {
    expect(rule(".adm-filter-bar")).toMatch(/flex-wrap:\s*wrap/);
    // The desktop spacer would otherwise eat a whole wrapped line.
    expect(rule(".adm-filter-bar .spacer")).toMatch(/display:\s*none/);
    expect(rule(".adm-filter-bar .chip")).toMatch(/min-height:\s*44px/);
  });

  it("takes the filter-mini search full-width", () => {
    const search = rule(".adm-filter-bar .search-mini");
    expect(search).toMatch(/flex:\s*1 1 100%/);
    // min-width: 240px on desktop would force a 320px viewport to scroll.
    expect(search).toMatch(/min-width:\s*0/);
  });

  it("keeps the actions on the card, wrapping instead of overflowing", () => {
    const actions = rule(".adm-table td.actions");
    expect(actions).toMatch(/flex-wrap:\s*wrap/);
    expect(actions).toMatch(/grid-column:\s*1 \/ -1/);
  });

  it("wraps the pagination footer", () => {
    expect(rule(".posts-foot")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("shows the re-attached column labels ONLY in card mode", () => {
    // The one selector that legitimately appears twice: hidden by default
    // (desktop, where <thead> carries the headings)…
    expect(rule(".cell-label", CSS.slice(0, CSS.indexOf(MEDIA_OPEN)), false)).toMatch(
      /display:\s*none/,
    );
    // …and shown inside the media block, which is the declaration that wins.
    expect(rule(".cell-label")).toMatch(/display:\s*block/);
  });

  it("keeps the actions readable on a card: centred chips, a wrapping error", () => {
    // As flex items these are blockified, so min-height alone leaves the
    // bordered Delete chip's label pinned to the top of a 44px box.
    const tap = rule(".adm-table td.actions a,\n  .adm-table td.actions button");
    expect(tap).toMatch(/min-height:\s*44px/);
    expect(tap).toMatch(/display:\s*inline-flex/);
    expect(tap).toMatch(/align-items:\s*center/);
    // td.actions is nowrap on desktop; an arbitrary BFF error string would run
    // off the card and be clipped by .adm-card's overflow: hidden.
    const err = rule(".adm-table td.actions .row-err");
    expect(err).toMatch(/white-space:\s*normal/);
    expect(err).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("gives the published cell its own line, so the label cannot overlap a pill", () => {
    // "PUBLISHED" is one unbreakable ~65px word; sharing the pill row's 1fr
    // track would collapse it under a Voice-note + Unpublished pair at 320px.
    expect(rule(".adm-table td:nth-child(5)")).toMatch(/grid-column:\s*1 \/ -1/);
  });

  it("changes nothing above the breakpoint — every rule is inside the media query", () => {
    const desktop = CSS.slice(0, CSS.indexOf(MEDIA_OPEN));
    // The desktop table is still a table with its header and its nowrap columns.
    expect(desktop).toMatch(/\.adm-table \{ width: 100%; border-collapse: collapse;/);
    expect(desktop).toMatch(/\.adm-table th\.nowrap \{ white-space: nowrap; \}/);
    expect(desktop).not.toContain("display: grid");
    expect(desktop).not.toContain("thead");
    // …and nothing follows the media block that could override it unnoticed.
    // Without this, an appended rule sits in a region no assertion here reads.
    expect(CSS.slice(CSS.indexOf(MEDIA_OPEN) + MOBILE.length).trim()).toBe("");
  });
});
