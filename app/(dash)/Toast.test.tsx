// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ToastRegion, { ERROR_TTL_MS, SUCCESS_TTL_MS, resetToastsForTest, showToast } from "./Toast";

// Allow bare act(...) (used by the fake-timer test below) to flush effects
// without the "testing environment is not configured to support act" warning
// — same setup as LocalTime.test.tsx.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A tiny harness in the shape of the real tree: a screen raises a toast with
// the module-level `showToast()`, and the single <ToastRegion/> that the (dash)
// layout mounts renders it. The queue is module state, not component state, so
// the caller and the region need not be related in the tree at all — which is
// what lets ONE region serve twenty table rows.
function Harness() {
  return (
    <div>
      <button type="button" onClick={() => showToast("It worked.", "success")}>
        show success
      </button>
      <button type="button" onClick={() => showToast("It broke.", "error")}>
        show error
      </button>
      <ToastRegion />
    </div>
  );
}

afterEach(() => {
  cleanup();
  resetToastsForTest();
  vi.useRealTimers();
});

describe("useToast / ToastRegion", () => {
  it("mounts BOTH live regions even with zero toasts — a region that appears together with its first message never announces", () => {
    render(<Harness />);
    const polite = document.querySelectorAll('[aria-live="polite"]');
    const assertive = document.querySelectorAll('[aria-live="assertive"]');
    expect(polite).toHaveLength(1);
    expect(assertive).toHaveLength(1);
  });

  it("adds the message to the SAME region node that was already mounted — it does not create a region to hold it", () => {
    render(<Harness />);
    // Capture the actual DOM nodes before anything has ever been announced.
    const politeBefore = document.querySelector('[aria-live="polite"]') as HTMLElement;
    const assertiveBefore = document.querySelector('[aria-live="assertive"]') as HTMLElement;
    expect(politeBefore.textContent).toBe("");
    expect(assertiveBefore.textContent).toBe("");

    fireEvent.click(screen.getByText("show success"));
    fireEvent.click(screen.getByText("show error"));

    // NODE IDENTITY, not "a region exists": if React had replaced or re-created
    // the region to render the message, these would be different elements — and
    // an assistive technology would have had nothing to observe a mutation on.
    // This is the behavioural half of the `:empty { display: none }` fix; the
    // CSS contract below is the other half, because jsdom applies no
    // stylesheets and so cannot see a region that is hidden rather than absent.
    expect(document.querySelector('[aria-live="polite"]')).toBe(politeBefore);
    expect(document.querySelector('[aria-live="assertive"]')).toBe(assertiveBefore);
    expect(politeBefore.textContent).toContain("It worked.");
    expect(assertiveBefore.textContent).toContain("It broke.");
  });

  it("keeps ONE region pair when a second <ToastRegion/> is mounted — a stray mount is inert, never a duplicate live region", () => {
    render(
      <>
        <ToastRegion />
        <ToastRegion />
        <ToastRegion />
      </>,
    );
    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    expect(document.querySelectorAll('[aria-live="assertive"]')).toHaveLength(1);
    expect(document.querySelectorAll(".adm-toast-stack")).toHaveLength(1);
  });

  it("puts a success toast in the polite region and an error toast in the assertive one", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("show success"));
    fireEvent.click(screen.getByText("show error"));

    const polite = document.querySelector('[aria-live="polite"]') as HTMLElement;
    const assertive = document.querySelector('[aria-live="assertive"]') as HTMLElement;
    expect(within(polite).getByText("It worked.")).toBeTruthy();
    expect(within(assertive).getByText("It broke.")).toBeTruthy();
    expect(within(polite).queryByText("It broke.")).toBeNull();
    expect(within(assertive).queryByText("It worked.")).toBeNull();
  });

  it("auto-dismisses success at SUCCESS_TTL_MS while a same-moment error is still shown, and the error goes at ERROR_TTL_MS", () => {
    vi.useFakeTimers();
    render(<Harness />);
    act(() => {
      fireEvent.click(screen.getByText("show success"));
      fireEvent.click(screen.getByText("show error"));
    });
    expect(screen.getByText("It worked.")).toBeTruthy();
    expect(screen.getByText("It broke.")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(SUCCESS_TTL_MS);
    });
    expect(screen.queryByText("It worked.")).toBeNull();
    expect(screen.getByText("It broke.")).toBeTruthy(); // error outlives success

    act(() => {
      vi.advanceTimersByTime(ERROR_TTL_MS - SUCCESS_TTL_MS);
    });
    expect(screen.queryByText("It broke.")).toBeNull();
  });

  it("the per-toast dismiss button removes only that toast", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("show success"));
    fireEvent.click(screen.getByText("show error"));

    const dismissButtons = screen.getAllByLabelText("Dismiss notification");
    // Dismiss the success toast (first one shown, in the polite region).
    fireEvent.click(dismissButtons[0]);

    expect(screen.queryByText("It worked.")).toBeNull();
    expect(screen.getByText("It broke.")).toBeTruthy();
  });

  it("stacks multiple toasts of the same tone", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("show success"));
    fireEvent.click(screen.getByText("show success"));

    expect(screen.getAllByTestId("adm-toast")).toHaveLength(2);
    expect(screen.getAllByText("It worked.")).toHaveLength(2);
  });
});

// CSS CONTRACT — the ENG-964 block in globals.css. Vitest stubs CSS modules
// (N/A here, globals.css is plain CSS and never imported by a component under
// test), but getComputedStyle in jsdom does not apply real stylesheet rules
// either, so the only way to prove these facts is to read the rule text.
const CSS = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

function rule(selector: string): string {
  const marker = `${selector} {`;
  const hits: number[] = [];
  for (let i = CSS.indexOf(marker); i !== -1; i = CSS.indexOf(marker, i + 1)) {
    if (i === 0 || CSS[i - 1] === "\n") hits.push(i);
  }
  expect(hits.length, `${selector} should be declared exactly once in globals.css`).toBe(1);
  return CSS.slice(hits[0], CSS.indexOf("}", hits[0]));
}

describe("globals.css — ENG-964 CSS contract", () => {
  // The token used to be asserted as a sum of hand-declared constants
  // (16+16+36+1 === 69), which proved nothing — the test supplied its own
  // inputs, and the 36px "content row" was a guess that turned out to be wrong
  // on /analytics (71.75px) and /waitlist (70px), where the sticky header then
  // tucked UNDER the topbar and was painted over by it.
  //
  // The bar is now PINNED with a min-height instead, so the token is true by
  // construction on every screen rather than on the one it was measured from.
  // These two must move together; the e2e proof measures the rendered bar on
  // every table route and asserts it equals the token.
  it("pins the topbar so the token is true on every screen, not just the one it was measured on", () => {
    const declared = CSS.match(/--admin-topbar-h:\s*(\d+)px/);
    expect(declared, "--admin-topbar-h must be declared").not.toBeNull();
    const minHeight = CSS.match(/\.admin-topbar\s*\{\s*min-height:\s*(\d+)px/);
    expect(minHeight, ".admin-topbar must be pinned with a min-height").not.toBeNull();
    expect(declared![1]).toBe(minHeight![1]);
    // Tallest natural topbar measured on the built app is /analytics at
    // 71.75px, so the pin has to be at least that or the pin does nothing.
    expect(Number(minHeight![1])).toBeGreaterThanOrEqual(72);
  });

  it("parks the sticky table header directly under the topbar", () => {
    const th = rule(".adm-table thead th");
    expect(th).toMatch(/position:\s*sticky/);
    expect(th).toMatch(/top:\s*var\(--admin-topbar-h\)/);
  });

  it("gives the sticky header its own bottom rule — under border-collapse the cell border belongs to the TABLE and scrolls away with the rows", () => {
    expect(rule(".adm-table thead th")).toMatch(/box-shadow:\s*inset\s+0\s+-1px\s+0\s+var\(--line\)/);
  });

  // THE point of this ticket's a11y work. A live region that is not in the
  // accessibility tree when its content changes does not announce, and
  // `display: none` takes it out of that tree. `.adm-toast-region:empty
  // { display: none }` matched until the very first toast, so the region became
  // visible and gained its message in the same commit — silent, exactly the bug
  // the whole always-mounted architecture exists to avoid. jsdom applies no
  // stylesheets, so no render test can see this; the rule text is the evidence.
  it("never hides the live regions — no rule in globals.css may take .adm-toast-region out of the accessibility tree", () => {
    // Comments are stripped first — the block above TALKS about the rule it
    // forbids, and prose must not be able to fail (or pass) this test.
    const declarations = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    // Every rule whose selector mentions the region, with its declarations.
    const blocks = [...declarations.matchAll(/([^{}]*\.adm-toast-(?:region|stack)[^{}]*)\{([^}]*)\}/g)];
    expect(blocks.length, "the toast regions must be styled at all").toBeGreaterThan(0);
    for (const [, selector, body] of blocks) {
      expect(body, `${selector.trim()} must not hide the live region`).not.toMatch(/display:\s*none/);
      expect(body, `${selector.trim()} must not hide the live region`).not.toMatch(/visibility:\s*hidden|collapse/);
      expect(body, `${selector.trim()} must not hide the live region`).not.toMatch(/content-visibility:\s*hidden/);
    }
    // And specifically not behind :empty, which matches right up until the
    // first message — the exact window in which the region must be observable.
    expect(declarations).not.toMatch(/\.adm-toast-(?:region|stack)[^{}]*:empty/);
  });

  it("clips the card with overflow: clip, not hidden — hidden would make the card the table's scroll container and silently kill the sticky header", () => {
    expect(rule(".admin-main .adm-card")).toMatch(/overflow:\s*clip/);
  });

  it("is appended at the very end of the file — deliberately append-only because ENG-963 edits this same file concurrently", () => {
    const marker = "ENG-964 — perceived speed";
    const idx = CSS.indexOf(marker);
    expect(idx).toBeGreaterThan(-1);
    // The last rule the block declares (the sticky header) is also the last
    // thing in the whole file — nothing was appended after this ticket's work.
    const lastRule = ".adm-table thead th {";
    expect(CSS.lastIndexOf(lastRule)).toBeGreaterThan(idx);
    expect(CSS.trimEnd().endsWith("}")).toBe(true);
    expect(CSS.indexOf(lastRule, idx)).toBe(CSS.lastIndexOf(lastRule));
  });
});
