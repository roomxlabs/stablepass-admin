import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/admin";
import {
  formatRaceDate,
  formatJumpTime,
  raceMeta,
  raceTitle,
  sourcePill,
  statusPill,
  type RaceRow,
} from "./format";
import "./racing-manual.css";

// Manual races (RF6 / ENG-180) — the fallback console for when the Racing API feed
// isn't the answer: pre-API history, unmatched horses, feed outages, and corrections
// that have to stick. There is no mockup for this screen; it is built from the same
// admin primitives as the horses / trainers screens.
//
// Data-bearing (dash) page: it re-asserts requireAdminPage() rather than trusting the
// layout gate, because Next renders layout + page in parallel and caches the layout
// across soft navigations.

type Filter = "all" | "manual" | "api" | "overridden";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "manual", label: "Manual" },
  { key: "api", label: "From feed" },
  { key: "overridden", label: "Overridden" },
];

function matches(r: RaceRow, filter: Filter): boolean {
  if (filter === "manual") return r.source === "manual";
  if (filter === "api") return r.source === "api";
  if (filter === "overridden") return Boolean(r.manual_override);
  return true;
}

export default async function RacingManualPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { sb } = await requireAdminPage();
  const sp = await searchParams;
  const filter: Filter = (["all", "manual", "api", "overridden"] as const).includes(
    sp.filter as Filter,
  )
    ? (sp.filter as Filter)
    : "all";

  const { data, error } = await sb
    .from("race")
    .select(
      "id, venue, race_date, race_number, race_class, distance_m, scheduled_at, status, source, manual_override, finished_at",
    )
    .order("race_date", { ascending: false });

  // Never let a failed read render as "No races yet" — a silent empty state would
  // hide an RLS or schema problem behind a screen that looks merely unused.
  if (error) {
    return (
      <>
        <div className="admin-topbar">
          <h1>Manual races</h1>
        </div>
        <div className="admin-content">
          <div className="adm-card">
            <div className="adm-empty">
              <h3>Couldn&apos;t load races</h3>
              <p>The race list is unavailable right now. Try again shortly.</p>
            </div>
          </div>
        </div>
      </>
    );
  }

  const all = (data ?? []) as RaceRow[];
  const counts = {
    all: all.length,
    manual: all.filter((r) => r.source === "manual").length,
    api: all.filter((r) => r.source === "api").length,
    overridden: all.filter((r) => r.manual_override).length,
  };
  const shown = all.filter((r) => matches(r, filter));

  return (
    <>
      <div className="admin-topbar">
        <h1>Manual races</h1>
        <div className="actions">
          <Link
            href="/racing-manual/new"
            className="btn btn-primary"
            style={{ padding: "8px 16px", fontSize: "13.5px" }}
          >
            + New race
          </Link>
        </div>
      </div>

      <div className="admin-content">
        <div className="adm-card">
          <div className="adm-card-head">
            <div>
              <h2>Race entry &amp; corrections</h2>
              <p className="sub">
                The Racing API feed is the primary source. Use this screen for races the feed
                doesn&apos;t have, and to correct the ones it does.
              </p>
            </div>
          </div>

          <div className="adm-filter-bar">
            {FILTERS.map((f) => (
              <Link
                key={f.key}
                href={f.key === "all" ? "/racing-manual" : `/racing-manual?filter=${f.key}`}
                className={f.key === filter ? "chip active" : "chip"}
              >
                {f.label}
                <strong>{counts[f.key]}</strong>
              </Link>
            ))}
            <div className="spacer" />
          </div>

          {shown.length === 0 ? (
            <div className="adm-empty">
              <h3>{filter === "all" ? "No races yet" : "No races match this filter"}</h3>
              <p>
                {filter === "all"
                  ? "Add a race the feed doesn't cover, then attach the runners and enter the result."
                  : "Try a different filter."}
              </p>
              <Link href="/racing-manual/new" className="btn btn-primary" style={{ padding: "10px 22px" }}>
                + New race
              </Link>
            </div>
          ) : (
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Race</th>
                  <th className="nowrap">Date</th>
                  <th className="nowrap">Jump</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th><span className="rm-sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const src = sourcePill(r);
                  const st = statusPill(r.status);
                  const meta = raceMeta(r);
                  return (
                    <tr key={r.id}>
                      <td>
                        <div className="row-name">
                          <Link href={`/racing-manual/${r.id}`}>{raceTitle(r)}</Link>
                        </div>
                        {meta ? <div className="row-sub">{meta}</div> : null}
                      </td>
                      <td className="nowrap">{formatRaceDate(r.race_date)}</td>
                      <td className="nowrap">{formatJumpTime(r.scheduled_at)}</td>
                      <td>
                        <span className={src.className}>{src.label}</span>
                      </td>
                      <td>
                        <span className={st.className}>{st.label}</span>
                      </td>
                      <td className="actions">
                        <Link href={`/racing-manual/${r.id}`}>Manage</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
