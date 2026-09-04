import { supabaseServer } from "@/lib/supabase/server";
import SearchField from "../SearchField";
import LocalTime from "../LocalTime";
import { listWaitlist, emailsFor } from "./data";
import CopyEmails from "./CopyEmails";
import "./waitlist.css";

// Waitlist — every pre-launch signup, newest first, with ?q= search over the
// address. Gated by the (dash) layout's requireAdminPage(): a non-admin never
// reaches it, and `public.waitlist` is admin-only at the RLS level besides.
//
// ENG-723 shipped the table with no admin screen on purpose, expecting launch
// invites to be exported by hand from the Supabase dashboard. This is the
// sanctioned reversal (Naufal, 2 Sep) — the same admin-only read, given a page.
export const dynamic = "force-dynamic";

type Search = { q?: string };

export default async function WaitlistPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const q = sp.q?.trim() || undefined;

  const sb = await supabaseServer();
  const { rows, total } = await listWaitlist(sb, { q });

  return (
    <>
      <div className="admin-topbar">
        <h1>Waitlist</h1>
        <div className="actions">
          <SearchField
            action="/waitlist"
            className="search wide"
            placeholder="Search by email…"
            ariaLabel="Search the waitlist by email"
            defaultValue={q ?? ""}
            hidden={{}}
          />
        </div>
      </div>

      <div className="admin-content">
        <div className="adm-card">
          <div className="adm-filter-bar">
            <span className="chip active">
              Signups <strong>{total}</strong>
            </span>
            {q ? (
              <span className="chip">
                Matching “{q}” <strong>{rows.length}</strong>
              </span>
            ) : null}
            <div className="spacer" />
            {/* The reason this page exists: the addresses have to get into a
                launch email. Copying the shown list beats re-typing it, and
                beats running SQL in the Supabase dashboard. */}
            <CopyEmails emails={emailsFor(rows)} count={rows.length} />
          </div>

          {rows.length === 0 ? (
            <p className="adm-empty">
              {q
                ? `No signups match “${q}”.`
                : "No signups yet. Addresses captured by the stablepass.co waitlist form appear here."}
            </p>
          ) : (
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
          )}
        </div>
      </div>
    </>
  );
}
