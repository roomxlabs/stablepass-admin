// Chart geometry for the analytics screens (ENG-276).
//
// Hand-rolled inline SVG — no chart library dependency. These are pure
// functions so the layout maths is unit-testable without a DOM.
//
// The coordinate system is lifted from the mockups (09-analytics.html,
// 10-post-analytics.html): every chart is a 420x150 viewBox with grid lines at
// y=20 / y=70 / y=120, bars growing UP from the y=120 baseline, and axis labels
// on the y=136 line.

export const VIEW_W = 420;
export const VIEW_H = 150;
export const BASELINE = 120;
export const TOP = 20;
export const GRID_YS = [120, 70, 20];
export const AXIS_Y = 136;

const PLOT_H = BASELINE - TOP; // 100

export type Bar = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** True for every bar tied for the maximum — rendered in --brand-green-darker. */
  peak: boolean;
  value: number;
  label: string;
  /** Tooltip text — the series' `title` when it has one, else its `label`. */
  title: string;
};

export type Point = { x: number; y: number; value: number; label: string; title: string };

/**
 * `label` is what the axis renders — keep it SHORT, the axis is only 420 units
 * wide and a wide first/last label clips at the viewBox edge. `title` is the
 * longer form used for the hover tooltip when the two differ.
 */
export type Series = { label: string; value: number; title?: string };

/**
 * Lay out a bar series across the full viewBox width.
 *
 * Bars are evenly spaced with `gap` between them and rounded value-ends
 * (rx=4, applied at render). A zero-valued bar still gets a hairline height so
 * the axis reads as a series rather than a gap — but an all-zero series is the
 * caller's cue to render the empty state instead.
 */
export function barLayout(series: Series[], gap = 5): Bar[] {
  if (series.length === 0) return [];
  const max = Math.max(...series.map((s) => s.value));
  const step = VIEW_W / series.length;
  const width = Math.max(1, step - gap);

  return series.map((s, i) => {
    // Guard the all-zero series: max=0 would make every ratio NaN. An exact
    // zero renders as NO bar — a hairline stub would read as real data.
    const ratio = max > 0 ? s.value / max : 0;
    const height = s.value === 0 ? 0 : Math.max(2, ratio * PLOT_H);
    return {
      x: i * step + gap / 2,
      y: BASELINE - height,
      width,
      height,
      peak: max > 0 && s.value === max,
      value: s.value,
      label: s.label,
      title: s.title ?? s.label,
    };
  });
}

/**
 * Lay out a line series (opens-since-publish). Points are inset from the edges
 * so the end dots and their value labels are not clipped by the viewBox.
 */
export function lineLayout(series: Series[], inset = 30): Point[] {
  if (series.length === 0) return [];
  const max = Math.max(...series.map((s) => s.value));
  const span = VIEW_W - inset * 2;
  // A single point sits at the left inset rather than dividing by zero.
  const step = series.length > 1 ? span / (series.length - 1) : 0;

  return series.map((s, i) => {
    const ratio = max > 0 ? s.value / max : 0;
    return {
      x: inset + i * step,
      y: BASELINE - ratio * PLOT_H,
      value: s.value,
      label: s.label,
      title: s.title ?? s.label,
    };
  });
}

/** `points` attribute for a <polyline>. */
export function polylinePoints(points: Point[]): string {
  return points.map((p) => `${round(p.x)},${round(p.y)}`).join(" ");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pick which axis labels to render. The mockups show only a handful (first,
 * a couple of interior ticks, last) so a 14-bar axis stays legible.
 */
export function axisTicks<T>(items: T[], max = 4): { item: T; index: number }[] {
  if (items.length === 0) return [];
  if (items.length <= max) return items.map((item, index) => ({ item, index }));
  const out: { item: T; index: number }[] = [];
  const stride = (items.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    const index = Math.round(i * stride);
    out.push({ item: items[index], index });
  }
  return out;
}

/** Horizontal fill percentage for the reactions-by-emoji bars. */
export function fillPercent(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.round((value / max) * 100);
}

// ---- Formatting -------------------------------------------------------------

/** 9860 -> "9,860" (thousands separators, matching the mockup tiles). */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-AU");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2026-07-16" -> "16 Jul" (the day-axis label format in the mockup). */
export function formatDayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "2026-07-16" -> "Thu 16" (the per-post opens-since-publish axis). */
export function formatWeekdayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}`;
}

/** "2026-07" -> "Jul" (the trials-by-month axis). */
export function formatMonthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(month);
  if (!m) return month;
  const idx = Number(m[2]) - 1;
  return MONTHS[idx] ?? month;
}

// ---- Hour-of-day ------------------------------------------------------------

// The opens-by-hour RPC buckets on the UTC hour. The ticket asks for the
// browser's local time, reusing the LocalTime approach from
// `feature/time-display-v1` — that branch is NOT merged into this base and no
// such helper exists here, so we take the ticket's stated fallback: render in
// AEST and label the axis accordingly (which is also what the mockup's
// "When members first see content · AEST" sub-heading says).
export const AEST_OFFSET_HOURS = 10;
export const HOUR_TZ_LABEL = "AEST";

/** 12 two-hour buckets, in AEST, matching the mockup's axis. */
export function hourBuckets(byHour: { hour: number; opens: number }[]): Series[] {
  const buckets = new Array(12).fill(0);
  for (const row of byHour) {
    const local = (((row.hour + AEST_OFFSET_HOURS) % 24) + 24) % 24;
    buckets[Math.floor(local / 2)] += row.opens;
  }
  // Axis label is the bucket's START hour only ("12am", "6am", "6pm") so the
  // 12 labels fit; the full "6am–8am" range rides the hover tooltip.
  return buckets.map((opens, i) => ({
    label: hour12(i * 2),
    value: opens,
    title: hourBucketLabel(i),
  }));
}

/** Bucket 0 -> "12am", 3 -> "6-8am", 9 -> "6-8pm". */
export function hourBucketLabel(bucket: number): string {
  const start = bucket * 2;
  const end = start + 2;
  return `${hour12(start)}–${hour12(end)}`;
}

/** Short form used on the axis: 0 -> "12am", 13 -> "1pm". */
export function hour12(h: number): string {
  const hh = ((h % 24) + 24) % 24;
  const suffix = hh < 12 ? "am" : "pm";
  const display = hh % 12 === 0 ? 12 : hh % 12;
  return `${display}${suffix}`;
}
