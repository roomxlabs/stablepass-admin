import Link from "next/link";
import LocalTime from "../LocalTime";
import SubscribedDate from "./SubscribedDate";
import { SUBSCRIBER_STATUSES, type SubscriberRow } from "./data";

// Presentational shell for the Subscribers screen: the status filter bar, the
// tenure band row, the table itself, and the paging footer.
//
// Split out of page.tsx so it can be rendered in a jsdom test without standing
// up a Supabase client — the same split waitlist/trainers/posts use. It takes
// plain data and holds no data-access of its own.
//
// Visually this is the existing admin resource screen (the `.adm-card` +
// `.adm-table` + `.adm-filter-bar` system already shipped by trainers, horses
// and waitlist). There is no subscribers mockup in `.rx/mockups.md`, so — as
// with waitlist — the other list screens are the reference, and every token
// value in subscribers.css is pulled from the design system's style.css rather
// than eyeballed.
//
// WHY THIS SCREEN EXISTS (Mel, 2 Sep client session): she wants to chase churn
// herself — "a tab or something where it shows you can stop… as soon as they've
// cancelled" — so a cancelled subscriber has to be visible on arrival, with no
// clicking. Hence the red pill AND the row accent AND a dedicated Cancelled
// column, rather than a status buried in a detail view.

export type TenureBand = {
  /** Query value, e.g. "6-11". `undefined` id means "Any". */
  id?: string;
  label: string;
  minMonths?: number;
  maxMonths?: number;
};

// The cohorts Mel actually asked to slice by ("filter it based on how many
// months they've been a subscriber"). Kept as data so the chips, the hrefs and
// the parsing in page.tsx all read from ONE list and cannot drift apart.
export const TENURE_BANDS: TenureBand[] = [
  { label: "Any" },
  { id: "0-2", label: "Under 3 months", minMonths: 0, maxMonths: 2 },
  { id: "3-5", label: "3–5 months", minMonths: 3, maxMonths: 5 },
  { id: "6-11", label: "6–11 months", minMonths: 6, maxMonths: 11 },
  { id: "12", label: "12+ months", minMonths: 12 },
];

export function bandById(id?: string): TenureBand | undefined {
  if (!id) return undefined;
  return TENURE_BANDS.find((b) => b.id === id);
}

/** Human label + pill colour for a subscription status. */
export function statusPill(status: string): { label: string; className: string } {
  switch (status) {
    case "active":
      return { label: "Active", className: "pill green dot" };
    case "trial":
      return { label: "Trial", className: "pill amber dot" };
    case "canceled":
      // RED IS RESERVED FOR CANCELLED. `lapsed` is also an unhappy state, but
      // giving it red too would defeat the one job this column has — letting
      // Mel spot the churn in a glance down the list.
      return { label: "Cancelled", className: "pill red dot" };
    case "lapsed":
      return { label: "Lapsed", className: "pill dot" };
    default:
      return { label: status, className: "pill" };
  }
}

export type SubscribersTableProps = {
  rows: SubscriberRow[];
  /** Every non-staff subscriber, ignoring active filters — the headline number. */
  total: number;
  /** How many rows the active filters match (equals `total` when unfiltered). */
  matching: number;
  status?: string;
  band?: string;
  q?: string;
  offset: number;
  limit: number;
};

type HrefParams = { status?: string; band?: string; q?: string; offset?: number };

/** Href for another slice/page of the same list. */
export function buildSubscribersHref({ status, band, q, offset = 0 }: HrefParams): string {
  const params = new URLSearchParams();
  if (status && status !== "all") params.set("status", status);
  if (band) params.set("band", band);
  if (q) params.set("q", q);
  if (offset > 0) params.set("offset", String(offset));
  const qs = params.toString();
  return qs ? `/subscribers?${qs}` : "/subscribers";
}

/**
 * Href for the CSV export. Carries the ACTIVE FILTERS but never the page
 * window — the export covers the whole filtered set, every page, which is the
 * acceptance criterion.
 */
export function buildExportHref({ status, band, q }: Omit<HrefParams, "offset">): string {
  const params = new URLSearchParams();
  if (status && status !== "all") params.set("status", status);
  const b = bandById(band);
  if (b?.minMonths !== undefined) params.set("minMonths", String(b.minMonths));
  if (b?.maxMonths !== undefined) params.set("maxMonths", String(b.maxMonths));
  if (q) params.set("q", q);
  const qs = params.toString();
  return qs ? `/api/admin/subscribers/export?${qs}` : "/api/admin/subscribers/export";
}

export default function SubscribersTable({
  rows,
  total,
  matching,
  status,
  band,
  q,
  offset,
  limit,
}: SubscribersTableProps) {
  const activeStatus = status && status !== "all" ? status : undefined;
  const filtered = Boolean(activeStatus || band || q);
  const prevOffset = Math.max(0, offset - limit);
  // Compare against the PAGE WINDOW, not the rows rendered — `rows.length` is
  // post-filtering, so on a last page that dropped a row `offset + rows.length
  // < matching` would stay true and walk the admin onto an empty page. Same
  // reasoning (and same pair) as the waitlist footer.
  const hasMore = offset + limit < matching;
  // "Nothing to show" is three different situations, and only one of them is an
  // empty subscriber base. A page past the end must still render the pager,
  // otherwise ?offset=100 is a dead end next to a headline count.
  const pastEnd = rows.length === 0 && offset > 0;

  return (
    <div className="adm-card">
      <div className="adm-filter-bar">
        {/* The headline count, not a filter — it borrows `.chip.active` purely
            for the emphasis treatment the other list screens use, so it needs
            its own hook for tests rather than being told apart by class.

            Labelled "All subscribers" ON PURPOSE. This counts every
            subscription record, cancelled and lapsed included, whereas the
            dashboard's Members tile counts only `trial` + `active`. Left
            unqualified ("Subscribers 8" beside "Members 5") the two screens
            look like they disagree; the word "All" plus the tooltip is what
            makes them reconcilable. */}
        <span
          className="chip active"
          data-testid="subscribers-total"
          title="Every subscription record, including lapsed and cancelled. The dashboard Members tile counts only trial and active, so it will read lower."
        >
          All subscribers <strong>{total}</strong>
        </span>
        <Link
          className={`chip${!activeStatus ? " active" : ""}`}
          href={buildSubscribersHref({ band, q })}
        >
          All
        </Link>
        {SUBSCRIBER_STATUSES.map((s) => (
          <Link
            key={s}
            className={`chip${activeStatus === s ? " active" : ""}`}
            href={buildSubscribersHref({ status: s, band, q })}
            data-testid={`status-filter-${s}`}
          >
            {statusPill(s).label}
          </Link>
        ))}
        <div className="spacer" />
        <a
          className="btn btn-primary"
          href={buildExportHref({ status, band, q })}
          download
          data-testid="subscribers-export"
        >
          Export CSV
        </a>
      </div>

      <div className="subs-filter-row">
        <span className="filter-label">Subscribed for</span>
        {TENURE_BANDS.map((b) => (
          <Link
            key={b.id ?? "any"}
            className={`chip${(band ?? undefined) === b.id ? " active" : ""}`}
            href={buildSubscribersHref({ status, band: b.id, q })}
            data-testid={`tenure-filter-${b.id ?? "any"}`}
          >
            {b.label}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="adm-empty">
          {pastEnd
            ? "Nothing on this page — the list ends earlier."
            : filtered
              ? "No subscribers match these filters."
              : "No subscribers yet. Members appear here as soon as they sign up."}
        </p>
      ) : (
        <table className="adm-table">
          <thead>
            <tr>
              <th scope="col">Subscriber</th>
              <th scope="col">Status</th>
              <th scope="col">Subscribed</th>
              <th scope="col">Tenure</th>
              <th scope="col">Period ends</th>
              {/* The caveat belongs ON THE SCREEN, not only in data.ts: there
                  is no `canceled_at` column, so this is the row's last-updated
                  time, which a later Stripe write can move. Mel acts on this
                  date by emailing people, so she should be able to see what it
                  actually means. */}
              <th
                scope="col"
                title="Approximate: taken from when the subscription row was last updated while cancelled. There is no dedicated cancellation-date column yet."
              >
                Cancelled *
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const pill = statusPill(row.status);
              const cancelled = row.status === "canceled";
              return (
                <tr
                  key={row.id}
                  className={cancelled ? "is-cancelled" : undefined}
                  data-testid={cancelled ? "subscriber-row-cancelled" : "subscriber-row"}
                >
                  <td>
                    <div className="row-name">{row.name ?? "—"}</div>
                    <div className="row-sub">
                      <a href={`mailto:${row.email}`}>{row.email}</a>
                    </div>
                  </td>
                  <td>
                    <span className={pill.className}>{pill.label}</span>
                  </td>
                  {/* Year-bearing: this column spans years, and the shared
                      `when` format renders none — see SubscribedDate.tsx. */}
                  <td className="muted">
                    <SubscribedDate iso={row.startedAt} />
                  </td>
                  <td className="subs-tenure">
                    {row.tenureMonths}
                    <span className="unit">{row.tenureMonths === 1 ? "mo" : "mos"}</span>
                  </td>
                  <td className="muted">
                    <SubscribedDate iso={row.currentPeriodEnd} />
                  </td>
                  <td className={cancelled ? "subs-cancelled-on" : "muted"}>
                    {row.canceledAt ? <LocalTime iso={row.canceledAt} kind="when" /> : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {rows.length > 0 || pastEnd ? (
        <div className="subscribers-foot">
          <div>
            Showing {rows.length} of {matching} subscriber{matching === 1 ? "" : "s"}
          </div>
          <div className="pager">
            {offset > 0 ? (
              <Link href={buildSubscribersHref({ status, band, q, offset: prevOffset })}>
                ‹ Prev
              </Link>
            ) : (
              <span className="disabled">‹ Prev</span>
            )}
            {hasMore ? (
              <Link href={buildSubscribersHref({ status, band, q, offset: offset + limit })}>
                Next ›
              </Link>
            ) : (
              <span className="disabled">Next ›</span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
