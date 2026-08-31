// ENG-881's acceptance is a set of CSS facts: below 720px the tiles go two-up,
// the two-column grids collapse, the period toggle goes full-width, and the
// three engagement tables stop being tables. Vitest stubs stylesheets — jsdom's
// getComputedStyle sees none of this — so a render test can never prove any of
// it, and every rule below could be deleted with the suite green. Read the
// stylesheet and assert on the rule text instead (the precedent is
// posts-css.test.ts, ENG-245, and compose-css.test.ts, ENG-558).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// process.cwd(), not import.meta.url: under Vitest import.meta.url is not a
// file: URL and readFileSync dies with "The URL must be of scheme file".
const CSS = readFileSync(join(process.cwd(), "app/(dash)/analytics/analytics.css"), "utf8");

// The mobile block, isolated. Everything ENG-881 adds lives inside it, so
// asserting against this slice also proves a rule is not leaking to desktop.
const MEDIA_OPEN = "@media (max-width: 719px) {";
function mobileBlock(): string {
  const start = CSS.indexOf(MEDIA_OPEN);
  expect(start, "analytics.css must declare the 720px content-stacking breakpoint").toBeGreaterThan(
    -1,
  );
  // Balance braces from the media query's own `{` to find its close.
  let depth = 0;
  for (let i = start + MEDIA_OPEN.length - 1; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}" && --depth === 0) return CSS.slice(start, i + 1);
  }
  throw new Error("unterminated @media block in analytics.css");
}
const MOBILE = mobileBlock();
const DESKTOP = CSS.slice(0, CSS.indexOf(MEDIA_OPEN));

/**
 * The same CSS with every comment removed.
 *
 * These rules are heavily commented and the prose names the very selectors and
 * properties under test ("<thead>", ".adm-table", "display: grid"), so a naive
 * substring assertion over the raw text passes or fails on the COMMENTARY
 * rather than the CSS. Strip comments before asserting on rule content.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Byte offsets of every occurrence of `selector {` that STARTS a line. */
function ownLineHits(selector: string, source: string): number[] {
  const marker = `${selector} {`;
  const hits: number[] = [];
  for (let i = source.indexOf(marker); i !== -1; i = source.indexOf(marker, i + 1)) {
    // Anchor on newline + indentation, not the line start: rules inside the
    // media block are indented. It also keeps a descendant selector such as
    // `.adm-table tbody tr:last-child {` from reading as a redeclaration of
    // `.adm-table tbody tr {`.
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
 * arrives as one selector in a comma list, or under a different,
 * higher-specificity selector. Those still need the e2e layout assertions.
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

describe("analytics.css — the <720px stacking transform (ENG-881)", () => {
  it("collapses BOTH stat-tile grids, including the 5-up override", () => {
    // `.adm-stats.five` is (0,2,0) and would out-specify a bare `.adm-stats`
    // mobile rule, leaving the five summary tiles at 44px wide each at 320px.
    // The comma-list rule is the only correct fix, so pin the list itself.
    expect(MOBILE).toMatch(
      /\.analytics-screen \.adm-stats,\s*\n\s*\.analytics-screen \.adm-stats\.five\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/,
    );
  });

  it("collapses BOTH two-column grids, including the .even override", () => {
    expect(MOBILE).toMatch(
      /\.analytics-screen \.adm-grid-2,\s*\n\s*\.analytics-screen \.adm-grid-2\.even\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/,
    );
  });

  it("takes the period toggle full-width with 44px tap targets", () => {
    // The shell's `.actions` is a content-sized flex item, so `width: 100%` on
    // the toggle alone resolves against ~191px. The e2e caught exactly that;
    // this pins the fix, and pins that it stays keyed to `> .period-toggle` so
    // it cannot reach the per-post screen's own topbar action.
    const row = rule(".admin-topbar .actions:has(> .period-toggle)");
    expect(row).toMatch(/flex:\s*1 1 100%/);
    const toggle = rule(".period-toggle");
    // inline-flex on desktop; `width: 100%` on an inline-flex box is honoured,
    // but flex is what lets the three options share the row evenly.
    expect(toggle).toMatch(/display:\s*flex/);
    expect(toggle).toMatch(/width:\s*100%/);
    const link = rule(".period-toggle a");
    expect(link).toMatch(/flex:\s*1 1 0/);
    expect(link).toMatch(/min-height:\s*44px/);
    // Blockified flex items need centring, or the label pins to the top-left
    // of the 44px box.
    expect(link).toMatch(/align-items:\s*center/);
    expect(link).toMatch(/justify-content:\s*center/);
  });

  it("stacks the tables into cards: no header, no table display", () => {
    expect(rule(".analytics-screen .adm-table thead")).toMatch(/display:\s*none/);
    expect(MOBILE).toMatch(
      /\.analytics-screen \.adm-table,\s*\n\s*\.analytics-screen \.adm-table tbody,\s*\n\s*\.analytics-screen \.adm-table tr,\s*\n\s*\.analytics-screen \.adm-table td\s*\{\s*display:\s*block/,
    );
  });

  it("lays each row out as a bordered, rounded, two-track card", () => {
    const card = rule(".analytics-screen .adm-table tbody tr");
    expect(card).toMatch(/display:\s*grid/);
    expect(card).toMatch(/grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(card).toMatch(/border:\s*1px solid var\(--line\)/);
    expect(card).toMatch(/border-radius:\s*12px/);
  });

  it("gives the name cell the full card width as its title", () => {
    const title = rule(".analytics-screen .adm-table tbody td:first-child");
    expect(title).toMatch(/grid-column:\s*1 \/ -1/);
    expect(title).toMatch(/border-bottom:\s*1px solid var\(--line\)/);
  });

  it("shows the re-attached column labels ONLY in card mode", () => {
    // Hidden above the breakpoint (desktop, where <thead> carries the
    // headings)…
    expect(rule(".analytics-screen .cell-label", DESKTOP, false)).toMatch(/display:\s*none/);
    // …and shown inside the mobile block.
    expect(rule(".analytics-screen .adm-table tbody td .cell-label")).toMatch(/display:\s*block/);
  });

  it("confines the desktop hide to a min-width query, not a bare selector", () => {
    // ENG-245's posts.css declares the SAME bare `.cell-label` selector and
    // shows it with `display: block` inside its own 719px block — equal (0,1,0)
    // specificity. Route stylesheets persist across soft navigations in the
    // (dash) layout, so a bare `.cell-label { display: none }` here would tie
    // with it and let navigation order decide whether the posts cards keep
    // their inline headings. Raising specificity would be worse (it would
    // out-specify posts and hide them outright), so each declaration is
    // confined to its own breakpoint. This pins that shape.
    expect(DESKTOP).toMatch(
      /@media \(min-width: 720px\) \{\s*\n\s*\.analytics-screen \.cell-label \{ display: none; \}\s*\n\}/,
    );
    // No bare, unqueried `.cell-label` rule may exist anywhere in the file.
    const bare = ownLineHits(".cell-label", CSS).filter((i) => {
      // Inside a media block iff an unclosed `{` precedes it.
      const before = CSS.slice(0, i);
      return (before.match(/\{/g) ?? []).length === (before.match(/\}/g) ?? []).length;
    });
    expect(bare, "`.cell-label` must never be declared at the top level").toEqual([]);
  });

  it("drops the right-alignment that only makes sense in a column", () => {
    expect(MOBILE).toMatch(
      /\.analytics-screen \.adm-table td\.num,\s*\n\s*\.analytics-screen \.adm-table th\.num\s*\{\s*text-align:\s*left/,
    );
  });

  it("lets every unbounded string wrap rather than widen its card", () => {
    // .adm-card is overflow: hidden, so an un-wrapped horse name or member
    // email is silently CLIPPED rather than reported as document overflow.
    expect(MOBILE).toMatch(
      /\.analytics-screen \.adm-table td \.row-name,\s*\n\s*\.analytics-screen \.adm-table td \.row-sub\s*\{\s*overflow-wrap:\s*anywhere/,
    );
    expect(rule(".analytics-screen .aggregate-note")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".analytics-screen .post-hero h2")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".analytics-screen .emoji-row .lbl")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("wraps the card head so a Download CSV action cannot squeeze the heading", () => {
    const head = rule(".analytics-screen .adm-card-head");
    expect(head).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".analytics-screen .adm-card-head .btn")).toMatch(/min-height:\s*44px/);
  });

  it("narrows the emoji-bar label track so the 320px card still has a track", () => {
    // Desktop is `84px 1fr 44px` with 10px gaps inside an 18px gutter; at 320px
    // that leaves the bar itself under 100px.
    expect(rule(".analytics-screen .emoji-row")).toMatch(
      /grid-template-columns:\s*72px minmax\(0, 1fr\) 40px/,
    );
  });

  it("scopes EVERY mobile rule to .analytics-screen, so nothing bleeds to /", () => {
    // The rules below restyle `.adm-table`, `.adm-stats`, `.adm-stat`,
    // `.adm-grid-2` and `.adm-card-head` — SHARED design-system classes. The
    // dashboard (app/(dash)/page.tsx) uses all five and dashboard.css declares
    // no media query of its own, and App Router keeps a route's CSS chunk in
    // the document after a soft navigation inside (dash). So an unscoped
    // `.adm-table tbody tr { display: grid }` here would reach `/` and turn the
    // dashboard's tables into unlabelled card grids for anyone who navigated
    // there from /analytics on a phone. This is the assertion that stops it.
    const selectorLines = code(MOBILE)
      .split("\n")
      .filter((l) => /^\s+[.#:[a-zA-Z][^{}:;]*,?\s*$/.test(l) || /^\s+[.#:[a-zA-Z][^{};]*\{/.test(l));
    expect(selectorLines.length).toBeGreaterThan(20);
    const unscoped = selectorLines
      .map((l) => l.trim().replace(/\s*\{.*$/, "").replace(/,$/, ""))
      .filter((sel) => !sel.startsWith(".analytics-screen "));
    // The ONE permitted exception: the topbar is a SIBLING of .admin-content,
    // so it cannot take the descendant scope. It is scoped by content instead
    // (`:has(> .period-toggle)` matches only where a period toggle exists).
    // The permitted exceptions, all three of them topbar-resident: the topbar
    // is a SIBLING of `.admin-content`, so nothing in it can take a descendant
    // scope. `.actions` is scoped by content instead (`:has(> .period-toggle)`
    // matches only where a toggle exists), and `.period-toggle` needs no scope
    // because — unlike the shared `.adm-*` classes — it is rendered by exactly
    // one component in the app and so cannot collide with another screen.
    expect(unscoped.sort()).toEqual(
      [
        ".admin-topbar .actions:has(> .period-toggle)",
        ".period-toggle",
        ".period-toggle a",
      ].sort(),
    );
  });

  it("changes nothing above the breakpoint — every rule is inside the media query", () => {
    // The desktop table is still a table, the tiles are still 4/5-up, and the
    // grids still have their two columns.
    expect(DESKTOP).toMatch(/\.adm-table \{ width: 100%; border-collapse: collapse;/);
    expect(DESKTOP).toMatch(/\.adm-stats \{ display: grid; grid-template-columns: repeat\(4, 1fr\)/);
    expect(DESKTOP).toMatch(/\.adm-stats\.five \{ grid-template-columns: repeat\(5, 1fr\); \}/);
    expect(DESKTOP).toMatch(/\.adm-grid-2 \{ display: grid; grid-template-columns: 1\.4fr 1fr/);
    expect(DESKTOP).toMatch(/\.adm-grid-2\.even \{ grid-template-columns: 1fr 1fr; \}/);
    expect(code(DESKTOP)).not.toContain("thead");
    // …and no rule above the breakpoint may carry the mobile scope class.
    expect(code(DESKTOP).replace(/@media \(min-width: 720px\)[\s\S]*$/, "")).not.toContain(
      ".analytics-screen",
    );
    // …and nothing follows the media block that could override it unnoticed.
    // Without this, an appended rule sits in a region no assertion here reads.
    expect(CSS.slice(CSS.indexOf(MEDIA_OPEN) + MOBILE.length).trim()).toBe("");
  });
});
