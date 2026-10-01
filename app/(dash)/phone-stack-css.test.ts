// ENG-1590 — phone-width list stacking is entirely CSS (Vitest stubs CSS
// modules, and globals.css / horses.css are plain stylesheets loaded by
// class name, so no render test can prove any of this either way — see
// compose-css.test.ts's header for the same reasoning). Read the rule text.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

const GLOBALS = read("app", "globals.css");
const HORSES = read("app", "(dash)", "horses", "horses.css");
const DASHBOARD = read("app", "(dash)", "dashboard.css");

/**
 * The full text of the FIRST top-level `@media (max-width: 767px) { … }`
 * block in `css`, found by counting braces from the query's opening one so a
 * nested rule's own `}` does not end the search early.
 */
function mediaBlock(css: string, query: string): string {
  const start = css.indexOf(`${query} {`);
  expect(start, `no ${query} block`).toBeGreaterThanOrEqual(0);
  const openBrace = css.indexOf("{", start);
  let depth = 0;
  for (let i = openBrace; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(openBrace + 1, i);
    }
  }
  throw new Error(`unterminated ${query} block`);
}

describe("phone-width list stacking (ENG-1590)", () => {
  it("globals.css's phone media query hides stack-hide cells", () => {
    const block = mediaBlock(GLOBALS, "@media (max-width: 767px)");
    expect(block).toContain(".admin-main .adm-table.stack-phone td.stack-hide");
    expect(block).toMatch(/\.admin-main \.adm-table\.stack-phone td\.stack-hide\s*\{\s*display:\s*none;/);
  });

  it("globals.css's phone media query prints each stacked cell's data-label as a caption", () => {
    const block = mediaBlock(GLOBALS, "@media (max-width: 767px)");
    expect(block).toContain(".admin-main .adm-table.stack-phone td[data-label]::before");
    expect(block).toMatch(
      /\.admin-main \.adm-table\.stack-phone td\[data-label\]::before\s*\{\s*content:\s*attr\(data-label\);/,
    );
  });

  it("horses.css still ships the desktop 6-up grid", () => {
    expect(HORSES).toContain(
      ".horse-grid-adm { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr));",
    );
  });

  it("horses.css drops the horse grid to 2 columns inside its own phone media query", () => {
    const block = mediaBlock(HORSES, "@media (max-width: 767px)");
    expect(block).toContain("repeat(2, minmax(0, 1fr))");
  });
});

// ENG-1639 — the dashboard itself (A3a-fix). It had no media query at all, so
// at 390px the tiles stayed 4-up and the two panels side by side (page
// scrollWidth 476). e2e/phone-screens.spec.ts proves the rendered result; this
// pins the rule text so deleting either phone block goes red here too.
describe("dashboard at phone width (ENG-1639)", () => {
  it("dashboard.css still ships the desktop 4-up tiles and the 1.4fr/1fr panels", () => {
    expect(DASHBOARD).toMatch(/\.adm-stats\s*\{[^}]*grid-template-columns:\s*repeat\(4, 1fr\);/);
    expect(DASHBOARD).toMatch(/\.adm-grid-2\s*\{[^}]*grid-template-columns:\s*1\.4fr 1fr;/);
  });

  it("the tiles step to 2 per row at the SAME width and value as the .sk-stats skeleton", () => {
    // globals.css steps the loading skeleton at 899px; stepping the real
    // tiles anywhere else makes them jump columns on swap-in.
    const sk = mediaBlock(GLOBALS, "@media (max-width: 899px)");
    const skCols = /\.sk-stats,\s*\.sk-stats\.five\s*\{\s*grid-template-columns:\s*([^;]+);/.exec(sk);
    expect(skCols, "skeleton step-down moved").toBeTruthy();
    const real = mediaBlock(DASHBOARD, "@media (max-width: 899px)");
    const realCols = /\.adm-stats\s*\{\s*grid-template-columns:\s*([^;]+);/.exec(real);
    expect(realCols, "no 2-up .adm-stats rule in dashboard.css's 899px block").toBeTruthy();
    expect(realCols![1].trim()).toBe("repeat(2, 1fr)");
    expect(realCols![1].trim()).toBe(skCols![1].trim());
  });

  it("the race-day / quiet-horses panels stack to one shrinkable column below 768px", () => {
    const block = mediaBlock(DASHBOARD, "@media (max-width: 767px)");
    expect(block).toMatch(/\.adm-grid-2\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
  });

  it("the Recently published table opts into the shared stacked-card treatment", () => {
    const page = read("app", "(dash)", "page.tsx");
    expect(page).toContain('className="adm-table stack-phone"');
    expect(page).toContain('data-label="Posted as"');
    expect(page).toContain('data-label="Published"');
  });
});
