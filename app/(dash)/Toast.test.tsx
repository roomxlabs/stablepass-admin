// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ToastRegion, { ERROR_TTL_MS, SUCCESS_TTL_MS, useToast } from "./Toast";

// Allow bare act(...) (used by the fake-timer test below) to flush effects
// without the "testing environment is not configured to support act" warning
// — same setup as LocalTime.test.tsx.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A tiny harness so the hook is exercised the same way a real screen uses it:
// showToast from a click handler, ToastRegion mounted once, dismissToast wired
// through to the per-toast button.
function Harness() {
  const { toasts, showToast, dismissToast } = useToast();
  return (
    <div>
      <button type="button" onClick={() => showToast("It worked.", "success")}>
        show success
      </button>
      <button type="button" onClick={() => showToast("It broke.", "error")}>
        show error
      </button>
      <ToastRegion toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

afterEach(() => {
  cleanup();
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
