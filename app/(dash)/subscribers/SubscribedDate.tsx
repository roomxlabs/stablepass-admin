"use client";

// An absolute calendar date WITH THE YEAR, rendered in the browser's timezone.
//
// Why this exists instead of the shared `<LocalTime kind="when">`: `whenLabel`
// in ../LocalTime.tsx only ever emits `{ day: "numeric", month: "short" }` —
// it never renders a year — and for anything inside seven days it emits a bare
// weekday + time instead ("Fri 11:05 PM"). That is right for the posts library,
// where every row is recent. It is wrong here: this screen deliberately spans
// YEARS, so a subscriber who joined Feb 2025 and one who joined Feb 2026 both
// rendered as "Feb 15" — indistinguishable, four rows apart, on the one screen
// whose subject is how long people have been subscribed. The "Period ends"
// column had the matching problem: two incompatible formats in one column.
//
// Kept in this feature's own directory rather than added as a fourth `kind` to
// LocalTime, so the shared component (and its test) stay untouched.
//
// SSR-safety is copied exactly from LocalTime: the label starts empty so the
// server render and the first client render are identical, and the real value
// is filled after mount — the browser's timezone is not available during SSR,
// so this deferred fill is what guarantees zero hydration mismatch. A null or
// unparseable date renders an empty <time> and never throws.

import { useEffect, useState } from "react";

/**
 * Pure label computer, exported so the unit suite can assert output directly
 * without mounting. Returns "" for null/unparseable input.
 */
export function formatSubscribedDate(iso: string | null): string {
  if (iso == null) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function SubscribedDate({ iso }: { iso: string | null }) {
  const [label, setLabel] = useState("");
  useEffect(() => {
    // Deferred on purpose — see the hydration note above.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLabel(formatSubscribedDate(iso));
  }, [iso]);
  return <time dateTime={iso ?? undefined}>{label}</time>;
}
