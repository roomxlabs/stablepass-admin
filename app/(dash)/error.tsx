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
    <div className="admin-content" role="alert">
      <div
        style={{
          maxWidth: 560,
          margin: "48px auto",
          padding: "24px",
          border: "1px solid var(--line, #e5e5e5)",
          borderRadius: 12,
          background: "var(--surface, #fff)",
        }}
      >
        <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>This page couldn&apos;t load</h2>
        <p style={{ margin: "0 0 16px", color: "var(--muted, #666)", fontSize: 14, lineHeight: 1.5 }}>
          Something went wrong reading the data for this screen. Nothing was changed. Try again — if
          it keeps happening, the reference below will be in the server logs.
        </p>
        {error.digest ? (
          <p style={{ margin: "0 0 16px", fontSize: 12, color: "var(--muted, #666)" }}>
            Reference: <code>{error.digest}</code>
          </p>
        ) : null}
        <button type="button" className="btn btn-primary" onClick={reset} style={{ padding: "8px 16px" }}>
          Try again
        </button>
      </div>
    </div>
  );
}
