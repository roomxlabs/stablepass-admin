import { describe, expect, it } from "vitest";
import {
  BASELINE,
  TOP,
  VIEW_W,
  axisTicks,
  barLayout,
  fillPercent,
  formatDayLabel,
  formatMonthLabel,
  formatNumber,
  hour12,
  hourBucketLabel,
  hourBuckets,
  lineLayout,
  polylinePoints,
} from "./chart";

describe("barLayout", () => {
  it("scales the tallest bar to the full plot height and marks it the peak", () => {
    const bars = barLayout([
      { label: "a", value: 50 },
      { label: "b", value: 100 },
    ]);
    expect(bars[1].height).toBe(BASELINE - TOP);
    expect(bars[1].y).toBe(TOP);
    expect(bars[1].peak).toBe(true);
    expect(bars[0].height).toBe((BASELINE - TOP) / 2);
    expect(bars[0].peak).toBe(false);
  });

  it("spans the full viewBox width", () => {
    const bars = barLayout([
      { label: "a", value: 1 },
      { label: "b", value: 1 },
      { label: "c", value: 1 },
    ]);
    expect(bars).toHaveLength(3);
    expect(bars[0].x).toBeGreaterThanOrEqual(0);
    const last = bars[2];
    expect(last.x + last.width).toBeLessThanOrEqual(VIEW_W);
  });

  it("does not produce NaN geometry for an all-zero series", () => {
    const bars = barLayout([
      { label: "a", value: 0 },
      { label: "b", value: 0 },
    ]);
    for (const b of bars) {
      expect(Number.isNaN(b.height)).toBe(false);
      expect(Number.isNaN(b.y)).toBe(false);
      expect(b.peak).toBe(false);
    }
  });

  it("returns nothing for an empty series", () => {
    expect(barLayout([])).toEqual([]);
  });
});

describe("lineLayout", () => {
  it("puts the highest value at the top of the plot and spans the width", () => {
    const pts = lineLayout([
      { label: "d1", value: 100 },
      { label: "d2", value: 50 },
      { label: "d3", value: 0 },
    ]);
    expect(pts[0].y).toBe(TOP);
    expect(pts[2].y).toBe(BASELINE);
    expect(pts[0].x).toBeLessThan(pts[2].x);
  });

  it("handles a single point without dividing by zero", () => {
    const pts = lineLayout([{ label: "d1", value: 7 }]);
    expect(pts).toHaveLength(1);
    expect(Number.isNaN(pts[0].x)).toBe(false);
  });

  it("serialises polyline points", () => {
    const pts = lineLayout([
      { label: "a", value: 1 },
      { label: "b", value: 1 },
    ]);
    expect(polylinePoints(pts)).toMatch(/^[\d.]+,[\d.]+ [\d.]+,[\d.]+$/);
  });
});

describe("axisTicks", () => {
  it("returns every item when the series is short", () => {
    expect(axisTicks([1, 2, 3])).toHaveLength(3);
  });

  it("thins a long series down and always includes first and last", () => {
    const items = Array.from({ length: 14 }, (_, i) => i);
    const ticks = axisTicks(items, 4);
    expect(ticks).toHaveLength(4);
    expect(ticks[0].index).toBe(0);
    expect(ticks[3].index).toBe(13);
  });
});

describe("hour buckets", () => {
  it("shifts UTC hours into AEST two-hour buckets", () => {
    // 20:00 UTC is 06:00 AEST -> the 6-8am bucket (index 3).
    const buckets = hourBuckets([{ hour: 20, opens: 500 }]);
    expect(buckets).toHaveLength(12);
    expect(buckets[3].value).toBe(500);
    // Axis label stays short so 12 labels fit the 420-unit viewBox; the full
    // range rides the tooltip title.
    expect(buckets[3].label).toBe("6am");
    expect(buckets[3].title).toBe("6am–8am");
  });

  it("wraps hours that cross midnight", () => {
    // 16:00 UTC is 02:00 AEST -> bucket 1.
    const buckets = hourBuckets([{ hour: 16, opens: 10 }]);
    expect(buckets[1].value).toBe(10);
  });

  it("sums multiple hours landing in the same bucket", () => {
    const buckets = hourBuckets([
      { hour: 20, opens: 100 },
      { hour: 21, opens: 50 },
    ]);
    expect(buckets[3].value).toBe(150);
  });

  it("formats 12-hour labels", () => {
    expect(hour12(0)).toBe("12am");
    expect(hour12(12)).toBe("12pm");
    expect(hour12(13)).toBe("1pm");
    expect(hourBucketLabel(0)).toBe("12am–2am");
  });
});

describe("formatting", () => {
  it("adds thousands separators", () => {
    expect(formatNumber(9860)).toBe("9,860");
  });

  it("formats day and month axis labels", () => {
    expect(formatDayLabel("2026-07-16")).toBe("16 Jul");
    expect(formatMonthLabel("2026-07")).toBe("Jul");
  });

  it("passes through an unparseable label rather than rendering Invalid Date", () => {
    expect(formatDayLabel("not-a-date")).toBe("not-a-date");
    expect(formatMonthLabel("nope")).toBe("nope");
  });

  it("computes fill percentages and guards a zero max", () => {
    expect(fillPercent(5, 10)).toBe(50);
    expect(fillPercent(0, 0)).toBe(0);
  });
});
