// Shared skeleton pieces for the five (dash) `loading.tsx` routes (ENG-964).
//
// SURFACE NOTE: the ticket's surface listed the five `loading.tsx` files but no
// shared module. Five copies of the same shell/table markup is exactly the
// duplication that drifts, so the common parts live here — a new, uniquely
// named, collision-free file (documented on ENG-964). The visual primitives it
// composes (`.sk`, `.sk-row`, `.sk-stat`, …) are in the append-only ENG-964
// block at the end of app/globals.css.
//
// ACCESSIBILITY: the skeleton bars themselves are decoration — a screen reader
// must hear "Loading the posts library", not forty grey rectangles. So the
// whole shell carries `aria-busy` plus one visually-hidden status line, and the
// bars are `aria-hidden`.
//
// That status line is mounted EMPTY and filled in an effect, which is why this
// module is a client component. Rendering `<p role="status">{label}</p>` in one
// commit would be the exact bug Toast.tsx warns about: a live region only
// announces mutations that happen while it is ALREADY in the DOM, so a region
// inserted together with its own text is silent. Mounting the node first and
// writing the label on the next tick makes it a real mutation, and therefore
// actually announced.

"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** The (dash) chrome a loading route shares with its real page: the sticky
 *  topbar (with the real title, so the heading never flickers) + content pad. */
export function SkeletonScreen({
  title,
  label,
  children,
}: {
  title: string;
  label: string;
  children: ReactNode;
}) {
  // Empty on the first commit, label written on the next — see the note above.
  // Written straight to the node rather than through state on purpose: the
  // announcement IS a DOM side effect (the "update an external system" case the
  // set-state-in-effect rule exists to steer you toward), and routing it through
  // state would re-render the whole skeleton to change one hidden string.
  const announce = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const node = announce.current;
    if (node) node.textContent = label;
  }, [label]);

  return (
    <div className="sk-screen" aria-busy="true" data-testid="route-skeleton">
      <div className="admin-topbar">
        <h1>{title}</h1>
        <div className="actions" aria-hidden="true">
          <div className="sk sk-block" style={{ height: 34, width: 280 }} />
          <div className="sk sk-block" style={{ height: 34, width: 118 }} />
        </div>
      </div>

      <div className="admin-content">
        {/* The only thing announced while the server page is in flight. */}
        <p
          ref={announce}
          role="status"
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            overflow: "hidden",
            clip: "rect(0 0 0 0)",
            whiteSpace: "nowrap",
          }}
        />
        <div aria-hidden="true">{children}</div>
      </div>
    </div>
  );
}

/** Stat-tile row — dashboard uses 4, analytics 5 (`.adm-stats five`). */
export function SkeletonStats({ count }: { count: number }) {
  return (
    <div className={count === 5 ? "sk-stats five" : "sk-stats"}>
      {Array.from({ length: count }, (_, i) => (
        <div className="sk-stat" key={i}>
          <div className="sk sk-line sm" style={{ width: "58%" }} />
          <div className="sk sk-line tall" style={{ width: "42%" }} />
          <div className="sk sk-line sm" style={{ width: "72%" }} />
        </div>
      ))}
    </div>
  );
}

/** A card-wrapped list: optional filter chips, a header band, then rows. */
export function SkeletonTable({
  columns,
  rows,
  chips = 0,
  thumbs = false,
}: {
  columns: number;
  rows: number;
  chips?: number;
  thumbs?: boolean;
}) {
  return (
    <div className="sk-card">
      {chips > 0 && (
        <div className="sk-filter-bar">
          {Array.from({ length: chips }, (_, i) => (
            <div className="sk sk-chip" key={i} />
          ))}
        </div>
      )}
      <div className="sk-row sk-head">
        {Array.from({ length: columns }, (_, i) => (
          <div className="sk sk-line sm" key={i} style={{ width: i === 0 ? "26%" : "12%" }} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div className="sk-row" key={r}>
          {thumbs && <div className="sk sk-block sk-thumb" />}
          <div className="sk-grow">
            <div className="sk sk-line" style={{ width: `${52 + ((r * 7) % 26)}%` }} />
          </div>
          {Array.from({ length: columns - 1 }, (_, c) => (
            <div className="sk sk-line sm" key={c} style={{ width: 74 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Card grid — the horses screen is a photo grid, not a table. */
export function SkeletonGrid({ tiles }: { tiles: number }) {
  return (
    <div className="sk-grid">
      {Array.from({ length: tiles }, (_, i) => (
        <div className="sk-tile" key={i}>
          <div className="sk sk-photo" />
          <div className="sk-body">
            <div className="sk sk-line tall" style={{ width: "62%" }} />
            <div className="sk sk-line sm" style={{ width: "44%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}
