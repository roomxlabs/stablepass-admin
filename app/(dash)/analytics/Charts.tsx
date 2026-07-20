// Inline-SVG chart primitives for the analytics screens (ENG-276).
//
// Hand-rolled to match the mockups 1:1 (09-analytics.html / 10-post-analytics.html):
// same 420x150 viewBox, same three grid lines, rounded value-ends (rx=4),
// peaks in --brand-green-darker, hover in --brand-green-dark. No chart library.

import {
  AXIS_Y,
  GRID_YS,
  VIEW_H,
  VIEW_W,
  axisTicks,
  barLayout,
  fillPercent,
  formatNumber,
  lineLayout,
  polylinePoints,
  type Series,
} from "./chart";

function Grid() {
  return (
    <>
      {GRID_YS.map((y) => (
        <line key={y} className="grid" x1="0" y1={y} x2={VIEW_W} y2={y} />
      ))}
    </>
  );
}

/** Quiet in-card message. A new platform is mostly zeros, so every card has one. */
export function ChartEmpty({ children }: { children: React.ReactNode }) {
  return <div className="chart-empty">{children}</div>;
}

function isEmpty(series: Series[]): boolean {
  return series.length === 0 || series.every((s) => s.value === 0);
}

export function BarChart({
  series,
  ariaLabel,
  emptyMessage,
  testId,
}: {
  series: Series[];
  ariaLabel: string;
  emptyMessage: string;
  testId?: string;
}) {
  if (isEmpty(series)) {
    return <ChartEmpty>{emptyMessage}</ChartEmpty>;
  }

  const bars = barLayout(series);
  const ticks = axisTicks(series);

  return (
    <div className="chart-wrap">
      <svg
        className="chart"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={ariaLabel}
        data-testid={testId}
      >
        <Grid />
        {bars.map((b, i) => (
          <rect
            key={i}
            className={b.peak ? "bar peak" : "bar"}
            x={b.x}
            y={b.y}
            width={b.width}
            height={b.height}
            rx="4"
          >
            <title>{`${b.title}: ${formatNumber(b.value)}`}</title>
          </rect>
        ))}
        {/* Value label above each peak, as in the mockup. */}
        {bars
          .filter((b) => b.peak)
          .map((b, i) => (
            <text
              key={`v${i}`}
              className="value-label"
              x={b.x + b.width / 2}
              y={b.y - 7}
              textAnchor="middle"
            >
              {formatNumber(b.value)}
            </text>
          ))}
        {ticks.map(({ item, index }) => {
          const b = bars[index];
          return (
            <text
              key={`a${index}`}
              className="axis-label"
              x={b.x + b.width / 2}
              y={AXIS_Y}
              textAnchor="middle"
            >
              {item.label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

export function LineChart({
  series,
  ariaLabel,
  emptyMessage,
  testId,
}: {
  series: Series[];
  ariaLabel: string;
  emptyMessage: string;
  testId?: string;
}) {
  if (isEmpty(series)) {
    return <ChartEmpty>{emptyMessage}</ChartEmpty>;
  }

  const points = lineLayout(series);
  const ticks = axisTicks(series, 5);
  // The mockup labels the opening (highest) day above its dot.
  const peak = points.reduce((a, b) => (b.value > a.value ? b : a), points[0]);

  return (
    <div className="chart-wrap">
      <svg
        className="chart"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={ariaLabel}
        data-testid={testId}
      >
        <Grid />
        {points.length > 1 ? (
          <polyline className="trend" points={polylinePoints(points)} />
        ) : null}
        {points.map((p, i) => (
          <circle key={i} className="trend-dot" cx={p.x} cy={p.y} r="4">
            <title>{`${p.title}: ${formatNumber(p.value)}`}</title>
          </circle>
        ))}
        <text className="value-label" x={peak.x} y={peak.y - 10} textAnchor="middle">
          {formatNumber(peak.value)}
        </text>
        {ticks.map(({ item, index }) => (
          <text
            key={`a${index}`}
            className="axis-label"
            x={points[index].x}
            y={AXIS_Y}
            textAnchor="middle"
          >
            {item.label}
          </text>
        ))}
      </svg>
    </div>
  );
}

/**
 * Reactions-by-emoji horizontal bars. Renders WHATEVER emoji the API returns —
 * there is deliberately no hardcoded reaction set here, because the final set
 * is still due from the client (see the ticket + the mockup's own note).
 */
export function EmojiBars({
  rows,
  emptyMessage,
  testId,
}: {
  rows: { emoji: string; count: number }[];
  emptyMessage: string;
  testId?: string;
}) {
  if (rows.length === 0 || rows.every((r) => r.count === 0)) {
    return <ChartEmpty>{emptyMessage}</ChartEmpty>;
  }

  const sorted = [...rows].sort((a, b) => b.count - a.count);
  const max = sorted[0].count;

  return (
    <div className="emoji-bars" data-testid={testId}>
      {sorted.map((r) => (
        <div className="emoji-row" key={r.emoji}>
          <div className="lbl">{r.emoji}</div>
          <div className="track">
            <div className="fill" style={{ width: `${fillPercent(r.count, max)}%` }} />
          </div>
          <div className="val">{formatNumber(r.count)}</div>
        </div>
      ))}
    </div>
  );
}
