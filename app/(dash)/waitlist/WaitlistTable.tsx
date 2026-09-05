import Link from "next/link";
import LocalTime from "../LocalTime";
import CopyEmails from "./CopyEmails";
import { emailsFor, type WaitlistRow } from "./data";

// Presentational shell for the Waitlist screen: the filter bar (headline count,
// export, copy), the table itself, and the paging footer.
//
// Split out of page.tsx so it can be rendered in a jsdom test without standing
// up a Supabase client — the same split trainers/posts use. It takes plain data
// and holds no data-access of its own.
//
// Visually this is the existing admin resource screen (02-dashboard.html's card
// + table, as already shipped by trainers/horses); there is no waitlist mockup,
// so the other list screens are the reference. The `.waitlist-foot .pager`
// rules mirror `.posts-foot .pager` so paging looks identical across screens.

export type WaitlistTableProps = {
  rows: WaitlistRow[];
  /** Every signup, ignoring any active search — the headline number. */
  total: number;
  /** How many rows the active search matches (equals `total` when not searching). */
  matching: number;
  q?: string;
  offset: number;
  limit: number;
};

/** Href for another page of the same (optionally filtered) list. */
export function buildWaitlistHref({ q, offset }: { q?: string; offset: number }): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (offset > 0) params.set("offset", String(offset));
  const qs = params.toString();
  return qs ? `/waitlist?${qs}` : "/waitlist";
}

/** Href for the CSV export, which covers the WHOLE list — never just this page. */
export function buildExportHref(q?: string): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  const qs = params.toString();
  return qs ? `/api/admin/waitlist/export?${qs}` : "/api/admin/waitlist/export";
}

export default function WaitlistTable({
  rows,
  total,
  matching,
  q,
  offset,
  limit,
}: WaitlistTableProps) {
  const prevOffset = Math.max(0, offset - limit);
  // Compare against the PAGE WINDOW, not the rows rendered. `rows.length` is
  // post-filtering (a row with a blank address is dropped), so on a last page
  // that dropped one, `offset + rows.length < matching` stays true and Next
  // stays live — walking the admin onto an empty page. `limit` is also what the
  // Next href actually advances by, so this is the consistent pair.
  const hasMore = offset + limit < matching;
  // Nothing to show can mean "the waitlist is empty", "the search matched
  // nothing", or "this page is past the end". The last one is NOT an empty
  // waitlist, and must still render the pager — otherwise ?offset=100 is a dead
  // end that says "No signups yet" next to a headline count of 28, with no link
  // back.
  const pastEnd = rows.length === 0 && offset > 0;

  return (
    <div className="adm-card">
      <div className="adm-filter-bar">
        <span className="chip active">
          Signups <strong>{total}</strong>
        </span>
        {q ? (
          <span className="chip">
            Matching “{q}” <strong>{matching}</strong>
          </span>
        ) : null}
        <div className="spacer" />
        {/* The reason this page exists: the addresses have to get into a launch
            email. The export is the sanctioned route for that — it downloads
            EVERY row, not the page on screen — so it leads. Copy stays for the
            quick "paste the visible names into a BCC" case. */}
        <a
          className="btn btn-primary"
          href={buildExportHref(q)}
          download
          data-testid="waitlist-export"
        >
          Export CSV
        </a>
        <CopyEmails emails={emailsFor(rows)} count={rows.length} />
      </div>

      {rows.length === 0 ? (
        <p className="adm-empty">
          {pastEnd
            ? "Nothing on this page — the list ends earlier."
            : q
              ? `No signups match “${q}”.`
              : "No signups yet. Addresses captured by the stablepass.co waitlist form appear here."}
        </p>
      ) : (
        <>
          <table className="adm-table">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Source</th>
                <th scope="col">Joined</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <a href={`mailto:${row.email}`}>{row.email}</a>
                  </td>
                  <td className="muted">{row.source ?? "—"}</td>
                  <td className="muted">
                    <LocalTime iso={row.joinedAt} kind="when" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {rows.length > 0 || pastEnd ? (
        <div className="waitlist-foot">
          <div>
            Showing {rows.length} of {matching} signup{matching === 1 ? "" : "s"}
          </div>
          <div className="pager">
            {offset > 0 ? (
              <Link href={buildWaitlistHref({ q, offset: prevOffset })}>‹ Prev</Link>
            ) : (
              <span className="disabled">‹ Prev</span>
            )}
            {hasMore ? (
              <Link href={buildWaitlistHref({ q, offset: offset + limit })}>Next ›</Link>
            ) : (
              <span className="disabled">Next ›</span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
