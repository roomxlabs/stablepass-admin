"use client";

// Shared client component that renders an absolute instant in the *browser's*
// timezone, not the server's. Every absolute time in the admin was formatted in
// Server Components, so on Vercel it rendered in UTC. This component fills its
// label in useEffect so the wall-clock reflects the operator's machine.
//
// Label rules are ported verbatim from the existing helpers, changing only the
// timezone basis (browser default) and the locale (undefined = browser default,
// replacing the hardcoded "en-AU"):
//   - kind="when":  app/(dash)/posts/format.ts  (schedLabel future + relTime past)
//   - kind="clock": app/(dash)/page.tsx#raceTime (dashboard race-queue time)
//   - kind="relative": app/(dash)/page.tsx#timeAgo (dashboard "posted N ago" ladder)
//
// SSR-safety: useState starts empty so the server render and the first client
// render are identical (an empty <time>). The label is computed only after mount
// in useEffect — zero hydration mismatch. A null or unparseable iso renders an
// empty <time> and never throws.

import { useEffect, useState } from "react";

export type LocalTimeKind = "when" | "clock" | "relative";

export interface LocalTimeProps {
  iso: string | null;
  kind: LocalTimeKind;
  className?: string;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** "7:45pm" — 12-hour wall-clock in the ambient timezone (dashboard raceTime). */
function clockLabel(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")}${ampm}`;
}

/**
 * Dashboard timeAgo ladder (app/(dash)/page.tsx). Instant-difference based, so
 * it is timezone-independent — the same everywhere. Math.floor, with the w/mo
 * tail the dashboard uses. Faithful to the source, including the "just now"
 * result for a future instant (the dashboard only ever feeds it a past time).
 */
function relativeLabel(then: number, now: number): string {
  const mins = Math.floor((now - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/**
 * Posts-library "when" label — the union of format.ts schedLabel (future) and
 * relTime (past), keyed on the sign of (then - now) so it reproduces today's
 * status-driven branch (scheduled posts are future, published posts are past)
 * without needing the row status:
 *   - future within 7 days  -> weekday form ("Mon 7:45 pm" in en-AU; locale-shaped)
 *   - further / older        -> date form   ("13 Jul" in en-AU; locale-shaped)
 *   - past within 7 days      -> relTime ladder ("3h ago", "yesterday", "3 days ago")
 * Uses Math.round like format.ts (distinct from the Math.floor relative ladder).
 */
function whenLabel(d: Date, then: number, now: number): string {
  const diff = then - now;
  if (diff >= 0) {
    return diff < SEVEN_DAYS_MS
      ? d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  const mins = Math.round((now - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * Pure label computer, evaluated in the ambient (browser) timezone. Exported so
 * the unit suite can prove per-TZ output directly with an injected `now`. A null
 * or unparseable `iso` yields "" (the component then renders an empty <time>).
 */
export function formatLocal(
  iso: string | null,
  kind: LocalTimeKind,
  now: Date = new Date(),
): string {
  if (iso == null) return "";
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return "";
  switch (kind) {
    case "clock":
      return clockLabel(d);
    case "relative":
      return relativeLabel(t, now.getTime());
    case "when":
      return whenLabel(d, t, now.getTime());
    default:
      return "";
  }
}

export default function LocalTime({ iso, kind, className }: LocalTimeProps) {
  // Empty on the server and on the first client paint (identical markup → no
  // hydration mismatch); the real label is filled after mount.
  const [label, setLabel] = useState("");
  useEffect(() => {
    // Deferred-hydration on purpose: the browser timezone/locale is an external
    // system unavailable during SSR, so we intentionally hold the label empty
    // through the server render + first client paint and fill it only after
    // mount — this is what guarantees zero hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLabel(formatLocal(iso, kind));
  }, [iso, kind]);
  return (
    <time dateTime={iso ?? undefined} className={className}>
      {label}
    </time>
  );
}
