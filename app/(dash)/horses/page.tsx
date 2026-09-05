import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/admin";
import { Icon } from "../icons";
import SearchField from "../SearchField";
import SortSelect from "../SortSelect";
import { buildListHref, compareValues, parseSortKey } from "../list-href";
import {
  formatCount,
  horseSubtitle,
  humanizeTrainingStatus,
  statusPillClass,
} from "./format";
import {
  fetchHorseLastPostMap,
  fetchHorses,
  fetchTrainerLabel,
  HORSE_SORT_KEYS,
  type CountEmbed,
  type HorseRow,
  type HorseSort,
} from "./data";
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

// `filter`, `q` and `trainerId` compose; only `page` is gone. The trainer
// scope is deliberately carried by every chip so an operator who arrived from
// the Trainers list stays inside that trainer's horses while flipping status.
// Now via the shared `buildListHref` (ENG-963) so all three list screens drop
// empty params identically. `sort` joins filter/q/trainerId as a carried param.
function buildHref(p: {
  filter?: Filter;
  q?: string;
  trainerId?: string;
  sort?: HorseSort | "";
}): string {
  return buildListHref("/horses", {
    trainerId: p.trainerId,
    filter: p.filter && p.filter !== "all" ? p.filter : "",
    q: p.q,
    // "newest" is the default order, so it is never written to the URL — a
    // shared link says what is non-default about the view and nothing else.
    sort: p.sort && p.sort !== "newest" ? p.sort : "",
  });
}

// The grid has no column headers to click, so sort is a select. Labels are the
// operator's words, not the column names.
const SORT_OPTIONS: { value: HorseSort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "name", label: "Name (A–Z)" },
  { value: "followers", label: "Most followers" },
  { value: "lastpost", label: "Recently posted" },
];

// Form hidden fields: everything the URL carries except the field's own input
// (`q` for the search box, `sort` for the select).
function hiddenFor(
  filter: Filter,
  trainerId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const h: Record<string, string> = {};
  if (trainerId) h.trainerId = trainerId;
  if (filter !== "all") h.filter = filter;
  return { ...h, ...extra };
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
  // A uuid, or nothing. Anything else is a malformed link and is ignored
  // rather than sent to Postgres as a filter value.
  const trainerId =
    typeof sp.trainerId === "string" && /^[0-9a-f-]{36}$/i.test(sp.trainerId) ? sp.trainerId : "";

  // "" is not a valid option value here — the select always shows a concrete
  // choice — so an absent/stale `?sort=` resolves to the historical default.
  const sort: HorseSort = parseSortKey(sp.sort, HORSE_SORT_KEYS) || "newest";

  const [all, trainerLabel, lastPostAt] = await Promise.all([
    fetchHorses(sb, q, trainerId || null, sort),
    trainerId ? fetchTrainerLabel(sb, trainerId) : Promise.resolve(null),
    // Only the "recently posted" sort needs this extra read.
    sort === "lastpost" ? fetchHorseLastPostMap(sb) : Promise.resolve(null),
  ]);

  const counts = {
    all: all.length,
    active: all.filter((h) => h.training_status !== "retired").length,
    racing: all.filter((h) => h.training_status === "racing").length,
    retired: all.filter((h) => h.training_status === "retired").length,
  };

  const unsorted = all.filter((h) => {
    if (filter === "active") return h.training_status !== "retired";
    if (filter === "racing") return h.training_status === "racing";
    if (filter === "retired") return h.training_status === "retired";
    return true;
  });

  // `name` / `newest` were already ordered by Postgres inside fetchHorses.
  // `followers` (an embedded count) and `lastpost` (not a column on `horse` at
  // all) can only be ordered here — which is exact, not a per-page
  // approximation, because this grid is unpaginated and `all` holds every row.
  // Ties break on display name so the order is total and stable across loads.
  const filtered =
    sort === "followers" || sort === "lastpost"
      ? [...unsorted].sort(
          (a, b) =>
            compareValues(
              sort === "followers"
                ? embedCount(a.follows)
                : lastPostAt?.get(a.id)
                  ? new Date(lastPostAt.get(a.id)!).getTime()
                  : null,
              sort === "followers"
                ? embedCount(b.follows)
                : lastPostAt?.get(b.id)
                  ? new Date(lastPostAt.get(b.id)!).getTime()
                  : null,
              "desc",
            ) || compareValues(a.display_name, b.display_name, "asc"),
        )
      : unsorted;

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
            hidden={hiddenFor(filter, trainerId, sort !== "newest" ? { sort } : {})}
          />
          <Link href="/horses/new" className="btn btn-primary" style={{ padding: "8px 16px", fontSize: "13.5px" }}>
            + Add horse
          </Link>
        </div>
      </div>

      <div className="admin-content">
        <div className="adm-card">
          {trainerId ? (
            // Arrived from the Trainers list's horse count (Justin, 2 Sep 2026).
            <div className="adm-scope-bar" data-testid="trainer-scope">
              <span>
                Showing horses for <strong>{trainerLabel ?? "an unknown trainer"}</strong>
              </span>
              <span className="scope-actions">
                <Link href={`/posts?trainerId=${encodeURIComponent(trainerId)}`} className="chip">
                  Their posts
                </Link>
                <Link href={buildHref({ filter, q, sort })} className="chip">
                  Show all horses
                </Link>
              </span>
            </div>
          ) : null}
          <div className="adm-filter-bar">
            {FILTERS.map((f) => (
              <Link
                key={f.key}
                href={buildHref({ filter: f.key, q, trainerId, sort })}
                className={f.key === filter ? "chip active" : "chip"}
              >
                {f.label}
                <strong style={{ marginLeft: 4, opacity: 0.7 }}>{counts[f.key]}</strong>
              </Link>
            ))}
            <div className="spacer" />
            <SortSelect
              action="/horses"
              options={SORT_OPTIONS}
              value={sort}
              ariaLabel="Sort horses"
              hidden={hiddenFor(filter, trainerId, q ? { q } : {})}
            />
            <SearchField
              action="/horses"
              className="search-mini"
              placeholder="Filter by trainer or stable…"
              ariaLabel="Filter horses"
              defaultValue={q}
              hidden={hiddenFor(filter, trainerId, sort !== "newest" ? { sort } : {})}
            />
          </div>

          {total === 0 ? (
            <div className="horse-empty">
              <h2>{q || filter !== "all" || trainerId ? "No horses match" : "No horses yet"}</h2>
              <p>
                {q || filter !== "all" || trainerId
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
