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
