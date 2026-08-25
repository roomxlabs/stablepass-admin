import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/admin";
import { Icon } from "../icons";
import SearchField from "../SearchField";
import {
  formatCount,
  horseSubtitle,
  humanizeTrainingStatus,
  statusPillClass,
} from "./format";
import { fetchHorses, type CountEmbed, type HorseRow } from "./data";
import { HORSE_PHOTO_BUCKET, signPhotoMap } from "@/lib/storage/photos";
import "./horses.css";

// Horses DB — screens/05-horses.html. Data-bearing (dash) page: it re-asserts
// requireAdminPage() rather than trusting the layout gate (Next renders layout
// + page in parallel and caches the layout across soft nav). Follower/post
// counts are derived via PostgREST embedded counts; age and the race-day
// description are computed in Postgres and read as computed columns (ENG-616).
//
// The empty state below is NEVER an inference about permissions. An AAL1 admin
// reads 0 rows from Postgres with no error, so "no rows" would otherwise be
// indistinguishable from "not allowed" — requireAdminPage() redirects before
// any read happens, and fetchHorses() throws on a query error rather than
// returning [], so reaching `.horse-empty` means the library really is empty.
//
// NO PAGINATION. The list renders every horse the operator can read, on one
// scrollable page, at Justin's request (hotfix, 25 Aug 2026). This only ever
// removed a CLIENT-SIDE `.slice()`: `fetchHorses()` already returned the whole
// table and the 12-per-page cut was applied afterwards, so nothing about the
// query changed and no round-trip was added. `signPhotoMap()` is still ONE
// batched `createSignedUrls` call, now over every row instead of twelve.
//
// A stale bookmark carrying `?page=2` is simply ignored — the param is no
// longer read, and an unknown search param is inert on a Server Component.

type Filter = "all" | "active" | "racing" | "retired";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "racing", label: "Racing" },
  { key: "retired", label: "Retired" },
];

function trainerName(t: HorseRow["trainer"]): string | null {
  if (!t) return null;
  const row = Array.isArray(t) ? t[0] : t;
  return row?.display_name ?? null;
}

function embedCount(e: CountEmbed | null): number {
  return e?.[0]?.count ?? 0;
}

// `filter` and `q` still compose exactly as before; only `page` is gone.
function buildHref(p: { filter?: Filter; q?: string }): string {
  const params = new URLSearchParams();
  if (p.filter && p.filter !== "all") params.set("filter", p.filter);
  if (p.q) params.set("q", p.q);
  const s = params.toString();
  return s ? `/horses?${s}` : "/horses";
}

export default async function HorsesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { sb } = await requireAdminPage();
  const sp = await searchParams;
  const filter: Filter = (["all", "active", "racing", "retired"] as const).includes(
    sp.filter as Filter,
  )
    ? (sp.filter as Filter)
    : "all";
  const q = typeof sp.q === "string" ? sp.q.trim() : "";

  const all: HorseRow[] = await fetchHorses(sb, q);

  const counts = {
    all: all.length,
    active: all.filter((h) => h.training_status !== "retired").length,
    racing: all.filter((h) => h.training_status === "racing").length,
    retired: all.filter((h) => h.training_status === "retired").length,
  };

  const filtered = all.filter((h) => {
    if (filter === "active") return h.training_status !== "retired";
    if (filter === "racing") return h.training_status === "racing";
    if (filter === "retired") return h.training_status === "retired";
    return true;
  });

  const total = filtered.length;
  // Private bucket: turn each stored photo path into a signed URL for display.
  // One batched call regardless of how many rows the filter left.
  const covers = await signPhotoMap(sb, HORSE_PHOTO_BUCKET, filtered.map((h) => h.photo_url));

  return (
    <>
      <div className="admin-topbar">
        <h1>Horses</h1>
        <div className="actions">
          <SearchField
            action="/horses"
            className="search"
            placeholder="Search horses…"
            ariaLabel="Search horses"
            defaultValue={q}
            hidden={filter !== "all" ? { filter } : {}}
          />
          <Link href="/horses/new" className="btn btn-primary" style={{ padding: "8px 16px", fontSize: "13.5px" }}>
            + Add horse
          </Link>
        </div>
      </div>

      <div className="admin-content">
        <div className="adm-card">
          <div className="adm-filter-bar">
            {FILTERS.map((f) => (
              <Link
                key={f.key}
                href={buildHref({ filter: f.key, q })}
                className={f.key === filter ? "chip active" : "chip"}
              >
                {f.label}
                <strong style={{ marginLeft: 4, opacity: 0.7 }}>{counts[f.key]}</strong>
              </Link>
            ))}
            <div className="spacer" />
            <SearchField
              action="/horses"
              className="search-mini"
              placeholder="Filter by trainer or stable…"
              ariaLabel="Filter horses"
              defaultValue={q}
              hidden={filter !== "all" ? { filter } : {}}
            />
          </div>

          {total === 0 ? (
            <div className="horse-empty">
              <h2>{q || filter !== "all" ? "No horses match" : "No horses yet"}</h2>
              <p>
                {q || filter !== "all"
                  ? "Try a different filter or search."
                  : "Add your first horse to start building the library."}
              </p>
              <Link href="/horses/new" className="btn btn-primary" style={{ padding: "10px 22px" }}>
                + Add horse
              </Link>
            </div>
          ) : (
            <>
              <div style={{ padding: 20 }}>
                <div className="horse-grid-adm">
                  {filtered.map((h) => {
                    const cover = h.photo_url ? covers.get(h.photo_url) ?? null : null;
                    return (
                    <Link key={h.id} href={`/horses/${h.id}/edit`} className="horse-card-adm">
                      <div className="cover">
                        {cover ? (
                          // eslint-disable-next-line @next/next/no-img-element -- signed Storage photo; mockup uses a plain cover img
                          <img src={cover} alt="" />
                        ) : (
                          <div className="cover-fallback">
                            <Icon name="horseHead" />
                          </div>
                        )}
                      </div>
                      <div className="body">
                        <p className="name">{h.display_name}</p>
                        <div className="meta">
                          {horseSubtitle({
                            trainerName: trainerName(h.trainer),
                            age: h.horse_age,
                            description: h.horse_description,
                            trainingStatus: h.training_status,
                          })}
                        </div>
                        <div className="stats">
                          <span>
                            <strong>{formatCount(embedCount(h.follows))}</strong> followers
                          </span>
                          <span>
                            <strong>{formatCount(embedCount(h.posts))}</strong> posts
                          </span>
                        </div>
                        <div style={{ marginTop: 10 }}>
                          <span className={statusPillClass(h.training_status)}>
                            {humanizeTrainingStatus(h.training_status)}
                          </span>
                        </div>
                      </div>
                    </Link>
                    );
                  })}
                </div>
              </div>

              <div className="horse-grid-foot">
                <div>
                  {total} {total === 1 ? "horse" : "horses"}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
