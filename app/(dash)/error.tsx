"use client";

import { useEffect } from "react";

// Error boundary for every (dash) page (ENG-984 review, MUST-FIX 5).
//
// WHY THIS EXISTS
// ---------------
// Before ENG-984, `getAnalytics` could not throw: every read degraded to
// `?? 0` / `?? []`, so a transient failure on the operator's landing page
// showed two zeroed tiles and left the rest of the screen — race-day queue,
// recent posts, nav — working. ENG-984 added `await getAdminUserIds(sb)`,
// which throws BY DESIGN (a silently empty admin set would put operator
// activity back into every number, the exact bug the ticket removes). That is
// the right call, but `app/(dash)/page.tsx` awaits `getAnalytics` inside a
// bare `Promise.all` with no boundary, so the throw took the entire dashboard
// to Next's default error screen — a new, undocumented failure mode on the
// first page an operator sees.
//
// This does not re-hide the error. Failing loud stays: a wrong number is worse
// than a missing one. What it does is keep the failure INSIDE the admin shell
// — the boundary sits under `(dash)/layout.tsx`, so the sidebar and nav
// survive and the operator can navigate away or retry, rather than landing on
// an unstyled full-page crash with no way out but the back button.
//
// Styling reuses `.dash-placeholder` from app/globals.css — the design
// system's existing card — rather than bespoke inline hexes, so this stays on
// palette if the tokens move.
//
// The message is deliberately generic. `error.message` from a server component
// is already redacted to a digest in production, and the underlying text can
// carry Postgres schema detail (see MUST-FIX 1) — so the digest is shown for a
// log lookup and nothing else is surfaced.
export default function DashError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("(dash) route error", error);
  }, [error]);

  return (
    <div className="admin-content">
      <div className="dash-placeholder" role="alert" style={{ maxWidth: 560, margin: "48px auto" }}>
        <h2>This page couldn&apos;t load</h2>
        <p>
          Something went wrong reading the data for this screen. Nothing was changed. Try again — if
          it keeps happening, the reference below will be in the server logs.
        </p>
        {error.digest ? (
          <p style={{ marginTop: 12, fontSize: 12 }}>
            Reference: <code>{error.digest}</code>
          </p>
        ) : null}
        <button
          type="button"
          className="btn btn-primary"
          onClick={reset}
          style={{ marginTop: 20, padding: "8px 16px" }}
        >
          Try again
        </button>
      </div>
    </div>
  );
}
