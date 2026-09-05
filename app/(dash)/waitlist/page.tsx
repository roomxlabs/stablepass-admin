import { requireAdminPage } from "@/lib/auth/admin";
import SearchField from "../SearchField";
import { listWaitlist, WAITLIST_PAGE_SIZE } from "./data";
import WaitlistTable from "./WaitlistTable";
import "./waitlist.css";

// Waitlist — every pre-launch signup, newest first, paged, with ?q= search over
// the address and a CSV export of the WHOLE list.
//
// Gated THREE times over, deliberately, because these rows are member email
// addresses: the (dash) layout's requireAdminPage(), this page's own
// re-assertion of it below, and `public.waitlist`'s RLS
// (`waitlist_select_admin` = is_admin + AAL2) which is enforced in Postgres
// regardless of what this code does.
//
// ENG-723 shipped the table with no admin screen on purpose, expecting launch
// invites to be exported by hand from the Supabase dashboard. This is the
// sanctioned reversal (Naufal, 2 Sep) — the same admin-only read, given a page.
// ENG-976 adds the paging + the export, which is the thing Mel actually asked
// for: the list that seeds the launch newsletter.
export const dynamic = "force-dynamic";

type Search = { q?: string; offset?: string };

export default async function WaitlistPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const q = sp.q?.trim() || undefined;
  const offset = Math.max(0, parseInt(sp.offset ?? "0", 10) || 0);

  // Re-assert the gate rather than trusting the (dash) layout's — the pattern
  // every other data-bearing dash page follows, and the one `.rx/gotchas.md`
  // insists on ("the (dash) layout gate does NOT gate a page's own data
  // fetch"). `requireAdminPage` is cache()-wrapped, so on this request it costs
  // nothing beyond the layout's own call. It matters most here: this screen's
  // rows are member email addresses.
  const { sb } = await requireAdminPage();
  const { rows, total, matching } = await listWaitlist(sb, {
    q,
    offset,
    limit: WAITLIST_PAGE_SIZE,
  });

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
        <WaitlistTable
          rows={rows}
          total={total}
          matching={matching}
          q={q}
          offset={offset}
          limit={WAITLIST_PAGE_SIZE}
        />
      </div>
    </>
  );
}
