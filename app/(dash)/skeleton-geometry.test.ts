import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A skeleton is only useful if its box is the SAME box as the thing it stands
// in for; otherwise the page visibly jumps the moment real data swaps in. These
// values are therefore MEASURED, not chosen — each one is read back out of the
// real component's own stylesheet here, so the two can never drift apart
// silently again. (This is deliberately not a design judgement: it asserts
// equality with production CSS, whatever production CSS happens to say.)
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

const globals = read("app", "globals.css");
const dashboard = read("app", "(dash)", "dashboard.css");
const analytics = read("app", "(dash)", "analytics", "analytics.css");
const posts = read("app", "(dash)", "posts", "posts.css");

/** Pull `prop` out of the first `selector { ... }` block in `css`. */
function decl(css: string, selector: string, prop: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(css);
  expect(block, `no rule for ${selector}`).toBeTruthy();
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(block![1]);
  expect(m, `no ${prop} in ${selector}`).toBeTruthy();
  return m![1].trim();
}

describe("skeleton geometry matches the real components it stands in for", () => {
  it(".sk-stats uses the same gutter as .adm-stats — a 2px-per-gutter jump is visible", () => {
    const real = decl(dashboard, ".adm-stats", "gap");
    // Both real stat grids agree, so there is one correct answer to copy.
    expect(decl(analytics, ".adm-stats", "gap")).toBe(real);
    expect(decl(globals, ".sk-stats", "gap")).toBe(real);
  });

  it(".sk-row is the same height as a real table row — 12px block padding, 22px inline", () => {
    // The real row's box: cells are `padding: 12px 14px`, and the first/last
    // cell widen to 22px, so the row's outer box is 12px by 22px.
    const cell = decl(posts, ".adm-table th,\n.adm-table td", "padding");
    const [block] = cell.split(/\s+/);
    const inline = decl(posts, ".adm-table th:first-child,\n.adm-table td:first-child", "padding-left");
    expect(block).toBe("12px");
    expect(inline).toBe("22px");
    expect(decl(globals, ".sk-row", "padding")).toBe(`${block} ${inline}`);
  });

  it(".sk-filter-bar still matches .adm-filter-bar — the row fix must not have been copied here", () => {
    expect(decl(globals, ".sk-filter-bar", "padding")).toBe(decl(posts, ".adm-filter-bar", "padding"));
    expect(decl(globals, ".sk-filter-bar", "gap")).toBe(decl(posts, ".adm-filter-bar", "gap"));
  });
});
