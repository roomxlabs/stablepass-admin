import { requireAdminPage } from "@/lib/auth/admin";
import SearchField from "../SearchField";
import { listSubscribers, SUBSCRIBERS_PAGE_SIZE } from "./data";
import SubscribersTable, { bandById } from "./SubscribersTable";
import "./subscribers.css";

// Subscribers — who is subscribed, for how long, and who has cancelled.
//
// From the 2 Sep client session. Mel wants to chase churn herself: "a tab or
// something where it shows you can stop… as soon as they've cancelled", so she
// can follow up by email. Naufal placed it here rather than on its own churn
// screen — "it'll be better on that members or subscribers page — you can
// filter it based on how many months they've been a subscriber" — plus the
// export he promised in the same breath.
//
// COPY: this view says "subscribers"/"members", never "trials" (the same call:
// "we don't have the trial anymore — we'll change it to subscriber"). `trial`
// still appears as a STATUS because it is a real value in `subscription.status`
// today; that is data, not framing. This ticket deliberately does NOT pre-empt
// the $19 pricing change, which is being grilled separately — the statuses here
// are exactly the ones that exist today.
//
// READ-ONLY. Nothing on this screen writes to `subscription`; those writes are
// service-role only.
//
// Gated twice over, deliberately, because these rows carry member names and
// email addresses: the (dash) layout's requireAdminPage(), and this page's own
// re-assertion of it below. `.rx/gotchas.md` insists on the second one — the
// (dash) layout gate does NOT gate a page's own data fetch. `requireAdminPage`
// is cache()-wrapped, so the re-assertion costs nothing on this request.
export const dynamic = "force-dynamic";

type Search = { status?: string; band?: string; q?: string; offset?: string };

export default async function SubscribersPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const status = sp.status?.trim() || undefined;
  // Resolve the band through the SAME table the chips render from, so an
  // unknown/hand-typed ?band= is simply ignored rather than producing a filter
  // no chip can clear.
  const bandId = bandById(sp.band?.trim())?.id;
  const band = bandById(bandId);
  const q = sp.q?.trim() || undefined;
  const offset = Math.max(0, parseInt(sp.offset ?? "0", 10) || 0);

  const { sb } = await requireAdminPage();
  const { rows, total, matching } = await listSubscribers(sb, {
    status,
    minMonths: band?.minMonths,
    maxMonths: band?.maxMonths,
    q,
    offset,
    limit: SUBSCRIBERS_PAGE_SIZE,
  });

  return (
    <>
      <div className="admin-topbar">
        <h1>Subscribers</h1>
        <div className="actions">
          <SearchField
            action="/subscribers"
            className="search wide"
            placeholder="Search by name or email…"
            ariaLabel="Search subscribers by name or email"
            defaultValue={q ?? ""}
            hidden={{
              ...(status ? { status } : {}),
              ...(bandId ? { band: bandId } : {}),
            }}
          />
        </div>
      </div>

      <div className="admin-content">
        <SubscribersTable
          rows={rows}
          total={total}
          matching={matching}
          status={status}
          band={bandId}
          q={q}
          offset={offset}
          limit={SUBSCRIBERS_PAGE_SIZE}
        />
      </div>
    </>
  );
}
