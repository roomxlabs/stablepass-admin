// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import LocalTime, { formatLocal } from "./LocalTime";

// Allow bare act(...) (used by the hydration test) to flush effects without the
// "testing environment is not configured to support act" warning.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The component reads the *ambient* timezone (browser default). In Node that is
// process.env.TZ, and Node re-reads it on assignment (tzset + V8 date-cache
// notification), so switching it at runtime lets one suite prove per-TZ output.
// Perth is UTC+8, Jakarta UTC+7 — a fixed one-hour offset, all year (neither
// observes DST), so the same instant differs by exactly one wall-clock hour.
function withTZ<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

const PERTH = "Australia/Perth"; // UTC+8
const JAKARTA = "Asia/Jakarta"; // UTC+7

// Fixed reference "now" so relative/when branches are deterministic.
const NOW = new Date("2026-07-13T02:00:00Z");
const H = 3_600_000;
const DAY = 24 * H;
// ISO string for an instant offset from NOW by `ms`.
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

afterEach(() => cleanup());

describe("formatLocal — kind=clock (browser-TZ wall clock)", () => {
  const iso = "2026-07-13T14:45:00Z"; // 22:45 Perth / 21:45 Jakarta

  it("renders the 12-hour dashboard shape and differs by the TZ offset", () => {
    const perth = withTZ(PERTH, () => formatLocal(iso, "clock", NOW));
    const jakarta = withTZ(JAKARTA, () => formatLocal(iso, "clock", NOW));
    expect(perth).toBe("10:45pm");
    expect(jakarta).toBe("9:45pm");
    expect(perth).not.toBe(jakarta); // the machine proof of browser-TZ rendering
  });

  it("formats midnight as 12:00am (12-hour)", () => {
    // 16:00Z = 00:00 next day in Perth (UTC+8)
    expect(withTZ(PERTH, () => formatLocal("2026-07-12T16:00:00Z", "clock", NOW))).toBe("12:00am");
  });

  it("formats noon as 12:00pm (12-hour)", () => {
    // 04:00Z = 12:00 in Perth (UTC+8)
    expect(withTZ(PERTH, () => formatLocal("2026-07-13T04:00:00Z", "clock", NOW))).toBe("12:00pm");
  });

  it("pads minutes to two digits", () => {
    // 15:05Z = 23:05 Perth
    expect(withTZ(PERTH, () => formatLocal("2026-07-13T15:05:00Z", "clock", NOW))).toBe("11:05pm");
  });
});

describe("formatLocal — kind=when (posts-library label, browser TZ)", () => {
  it("future within 7 days → weekday form, TZ-sensitive", () => {
    const iso = "2026-07-14T14:45:00Z"; // ~1.5 days ahead of NOW, within 7 days
    const perth = withTZ(PERTH, () => formatLocal(iso, "when", NOW));
    const jakarta = withTZ(JAKARTA, () => formatLocal(iso, "when", NOW));
    // Matches the platform's own weekday/hour/minute formatting (locale-agnostic).
    withTZ(PERTH, () =>
      expect(perth).toBe(
        new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }),
      ),
    );
    // Wall clock differs by the offset → real browser-TZ rendering.
    expect(perth).not.toBe(jakarta);
    expect(perth).toMatch(/:/); // weekday form carries a time, not a bare date
  });

  it("future beyond 7 days → date form, TZ-sensitive across the midnight boundary", () => {
    const iso = "2026-07-25T16:30:00Z"; // ~12 days ahead; 00:30 Perth (26th) vs 23:30 Jakarta (25th)
    const perth = withTZ(PERTH, () => formatLocal(iso, "when", NOW));
    const jakarta = withTZ(JAKARTA, () => formatLocal(iso, "when", NOW));
    withTZ(PERTH, () =>
      expect(perth).toBe(new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" })),
    );
    expect(perth).not.toMatch(/:/); // date form, no time
    expect(perth).not.toBe(jakarta); // different calendar day per TZ
  });

  it("exact 7-day future boundary → date form (further); one minute inside → weekday form", () => {
    const onBoundary = at(7 * DAY); // diff === 7 days → NOT within → date form
    const insideBoundary = at(7 * DAY - 60_000); // one minute inside → weekday form
    expect(withTZ(PERTH, () => formatLocal(onBoundary, "when", NOW))).not.toMatch(/:/);
    expect(withTZ(PERTH, () => formatLocal(insideBoundary, "when", NOW))).toMatch(/:/);
  });

  it.each([
    [-20_000, "just now"],
    [-3 * H, "3h ago"],
    [-DAY, "yesterday"],
    [-3 * DAY, "3 days ago"],
  ])("past within 7 days → relative branch (%i ms → %s), TZ-independent", (offset, expected) => {
    const iso = at(offset);
    expect(withTZ(PERTH, () => formatLocal(iso, "when", NOW))).toBe(expected);
    expect(withTZ(JAKARTA, () => formatLocal(iso, "when", NOW))).toBe(expected);
  });

  it("past 7 days or older → date form", () => {
    const iso = at(-8 * DAY);
    withTZ(PERTH, () =>
      expect(formatLocal(iso, "when", NOW)).toBe(
        new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }),
      ),
    );
  });
});

describe("formatLocal — kind=relative (dashboard timeAgo ladder, TZ-independent)", () => {
  it.each([
    [-20_000, "just now"],
    [-3 * H, "3h ago"],
    [-25 * H, "yesterday"],
    [-3 * DAY, "3 days ago"],
    [-14 * DAY, "2w ago"],
    [-60 * DAY, "2mo ago"],
  ])("(%i ms → %s)", (offset, expected) => {
    expect(formatLocal(at(offset), "relative", NOW)).toBe(expected);
  });

  it("is identical across timezones (pure instant difference)", () => {
    const iso = at(-3 * H);
    expect(withTZ(PERTH, () => formatLocal(iso, "relative", NOW))).toBe(
      withTZ(JAKARTA, () => formatLocal(iso, "relative", NOW)),
    );
  });
});

describe("formatLocal — null / invalid iso (render nothing, no throw)", () => {
  it.each(["when", "clock", "relative"] as const)("null → empty for kind=%s", (kind) => {
    expect(formatLocal(null, kind, NOW)).toBe("");
  });

  it.each(["when", "clock", "relative"] as const)("invalid iso → empty, no throw for kind=%s", (kind) => {
    expect(() => formatLocal("not-a-real-date", kind, NOW)).not.toThrow();
    expect(formatLocal("not-a-real-date", kind, NOW)).toBe("");
  });
});

describe("<LocalTime /> — SSR-safe rendering", () => {
  it("server render (renderToString) emits an EMPTY <time> — no label until the effect runs", () => {
    const html = renderToString(<LocalTime iso="2026-07-13T14:45:00Z" kind="clock" />);
    expect(html).toMatch(/<time[^>]*><\/time>/); // empty element, no label text
    expect(html).toMatch(/datetime="2026-07-13T14:45:00Z"/i); // machine-readable attr retained
    expect(html).not.toContain("pm"); // no browser-only label leaked to the server
  });

  it("null iso server render → empty <time> with no datetime attribute", () => {
    const html = renderToString(<LocalTime iso={null} kind="when" />);
    expect(html).toMatch(/<time[^>]*><\/time>/);
    expect(html).not.toMatch(/datetime/i);
  });

  it("fills the label after mount, in the ambient timezone", () => {
    const { container } = withTZ(PERTH, () =>
      render(<LocalTime iso="2026-07-13T14:45:00Z" kind="clock" />),
    );
    const el = container.querySelector("time")!;
    expect(el.textContent).toBe("10:45pm"); // effect ran, TZ-correct
    expect(el.getAttribute("datetime")).toBe("2026-07-13T14:45:00Z");
  });

  it("passes className through to the <time> element", () => {
    const { container } = render(<LocalTime iso="2026-07-13T14:45:00Z" kind="clock" className="when" />);
    expect(container.querySelector("time")!.className).toBe("when");
  });

  it("null iso renders an empty <time> after mount too (no throw)", () => {
    const { container } = render(<LocalTime iso={null} kind="when" />);
    const el = container.querySelector("time")!;
    expect(el.textContent).toBe("");
    expect(el.hasAttribute("datetime")).toBe(false);
  });

  it("hydrates without a mismatch warning (empty server shell === first client render)", async () => {
    const iso = "2026-07-13T14:45:00Z";
    const html = renderToString(<LocalTime iso={iso} kind="clock" />);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, <LocalTime iso={iso} kind="clock" />);
    });
    // Zero hydration mismatch: React logged nothing.
    expect(errorSpy).not.toHaveBeenCalled();
    // …and the effect then filled the label (in whatever the ambient TZ is here).
    expect(container.querySelector("time")!.textContent).toBe(formatLocal(iso, "clock"));
    expect(container.querySelector("time")!.textContent).toMatch(/^\d{1,2}:\d{2}(am|pm)$/);

    errorSpy.mockRestore();
    act(() => root!.unmount());
    document.body.removeChild(container);
  });
});
