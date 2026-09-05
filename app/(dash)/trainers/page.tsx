import Link from "next/link";
import { supabaseServer } from "@/lib/supabase/server";
import SearchField from "../SearchField";
import SortableTh from "../SortableTh";
import { buildListHref, parseSortDir, parseSortKey, type SortDir } from "../list-href";
import {
  listTrainers,
  timeAgo,
  trainerHorsesHref,
  trainerPostsHref,
  TRAINER_SORT_DEFAULT_DIR,
  TRAINER_SORT_KEYS,
  type TrainerRow,
  type TrainerSort,
} from "./data";
import { TRAINER_PHOTO_BUCKET, signPhotoMap } from "@/lib/storage/photos";
import "./trainers.css";

// Trainers DB — list with All/Active/Onboarding filters, ?q= search over
// name/stable/location, horse count, last-post recency and roster status.
// Gated by the (dash) layout's requireAdminPage(): a non-admin never reaches it.
export const dynamic = "force-dynamic";

type Search = { status?: string; q?: string; sort?: string; dir?: string };

// The sortable columns, in render order (ENG-963). Names and status open A→Z;
// the count and the recency column open biggest / most-recent first.
const SORT_COLUMNS: { column: TrainerSort; label: string; defaultDir: SortDir }[] = [
  { column: "trainer", label: "Trainer", defaultDir: TRAINER_SORT_DEFAULT_DIR.trainer },
  { column: "stable", label: "Stable", defaultDir: TRAINER_SORT_DEFAULT_DIR.stable },
  { column: "horses", label: "Horses", defaultDir: TRAINER_SORT_DEFAULT_DIR.horses },
  { column: "lastpost", label: "Last post", defaultDir: TRAINER_SORT_DEFAULT_DIR.lastpost },
  { column: "status", label: "Status", defaultDir: TRAINER_SORT_DEFAULT_DIR.status },
];

// Now the shared `buildListHref` (ENG-963) so trainers, posts and horses drop
// empty params identically — and so sort survives a chip click and a search.
function chipHref(
  status: string | undefined,
  q: string | undefined,
  sort: TrainerSort | "" = "",
  dir: SortDir = "asc",
): string {
  return buildListHref("/trainers", { status, q, sort, dir: sort ? dir : "" });
}

function TrainerThumb({ row }: { row: TrainerRow }) {
  if (row.photoUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- fixed 36px avatar, admin-only
    return <div className="row-thumb"><img src={row.photoUrl} alt="" /></div>;
  }
  const cls = row.status === "onboarding" ? "row-thumb mono muted" : "row-thumb mono";
  return <div className={cls}>{row.initials}</div>;
}

export default async function TrainersPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const status = sp.status === "active" || sp.status === "onboarding" ? sp.status : undefined;
  const q = sp.q?.trim() || undefined;
  const sort = parseSortKey(sp.sort, TRAINER_SORT_KEYS);
  const dir = parseSortDir(sp.dir, sort ? TRAINER_SORT_DEFAULT_DIR[sort] : "asc");

  const sb = await supabaseServer();
  const { rows, counts } = await listTrainers(sb, { status, q, sort, dir });

  // Private bucket: sign each trainer's photo path for the avatar thumbnails.
  const trainerPhotos = await signPhotoMap(sb, TRAINER_PHOTO_BUCKET, rows.map((r) => r.photoUrl));
  const signedRows = rows.map((r) => ({
    ...r,
    photoUrl: r.photoUrl ? trainerPhotos.get(r.photoUrl) ?? null : null,
  }));

  const filtered = Boolean(status || q);

  // Everything the URL carries except `q` — so typing keeps the chip AND the
  // sort. Passed through SearchField's `hidden` map (it is a GET form).
  const hiddenParams: Record<string, string> = {
    ...(status ? { status } : {}),
    ...(sort ? { sort, dir } : {}),
  };

  const sortHref = (column: string, nextDir: SortDir) =>
    chipHref(status, q, column as TrainerSort, nextDir);
  const columnProps = (column: TrainerSort) => {
    const def = SORT_COLUMNS.find((c) => c.column === column)!;
    return { column, label: def.label, defaultDir: def.defaultDir, sort, dir, hrefFor: sortHref };
  };

  return (
    <>
      <div className="admin-topbar">
        <h1>Trainers</h1>
        <div className="actions">
          <SearchField
            action="/trainers"
            className="search wide"
            placeholder="Search trainers…"
            ariaLabel="Search trainers"
            defaultValue={q ?? ""}
            hidden={hiddenParams}
          />
          <Link href="/trainers/new" className="btn btn-primary" style={{ padding: "8px 16px", fontSize: "13.5px" }}>
            + Add trainer
          </Link>
        </div>
      </div>

      <div className="admin-content">
        <div className="adm-card">
          <div className="adm-filter-bar">
            <Link href={chipHref(undefined, q, sort, dir)} className={!status ? "chip active" : "chip"}>
              All <strong>{counts.all}</strong>
            </Link>
            <Link
              href={chipHref("active", q, sort, dir)}
              className={status === "active" ? "chip active" : "chip"}
            >
              Active <strong>{counts.active}</strong>
            </Link>
            <Link
              href={chipHref("onboarding", q, sort, dir)}
              className={status === "onboarding" ? "chip active" : "chip"}
            >
              Onboarding <strong>{counts.onboarding}</strong>
            </Link>
            <div className="spacer" />
            <SearchField
              action="/trainers"
              className="search-mini"
              placeholder="Filter by stable or location…"
              ariaLabel="Filter trainers"
              defaultValue={q ?? ""}
              hidden={hiddenParams}
            />
          </div>

          {signedRows.length === 0 ? (
            <div className="adm-empty" data-testid="trainers-empty">
              <h3>{filtered ? "No trainers match" : "No trainers yet"}</h3>
              <p>
                {filtered
                  ? "Try clearing the filter or search."
                  : "Add your first trainer to start building the library."}
              </p>
              {!filtered ? (
                <Link href="/trainers/new" className="btn btn-primary" style={{ padding: "10px 20px" }}>
                  + Add trainer
                </Link>
              ) : null}
            </div>
          ) : (
            <table className="adm-table" data-testid="trainers-table">
              <thead>
                <tr>
                  <SortableTh {...columnProps("trainer")} style={{ width: "28%" }} />
                  <SortableTh {...columnProps("stable")} />
                  <SortableTh {...columnProps("horses")} className="nowrap" />
                  <SortableTh {...columnProps("lastpost")} className="nowrap" />
                  <SortableTh {...columnProps("status")} className="nowrap" />
                  <th />
                </tr>
              </thead>
              <tbody>
                {signedRows.map((row) => (
                  <tr key={row.id}>
                    <td className="with-thumb">
                      <TrainerThumb row={row} />
                      <div>
                        <div className="row-name">{row.displayName}</div>
                        {row.contactEmail ? <div className="row-sub">{row.contactEmail}</div> : null}
                      </div>
                    </td>
                    <td>
                      {row.stableName ?? "—"}
                      {row.location ? <div className="row-sub">{row.location}</div> : null}
                    </td>
                    <td className="nowrap">
                      {(() => {
                        const label = (
                          <>
                            <strong>{row.horseCount}</strong> {row.horseCount === 1 ? "horse" : "horses"}
                          </>
                        );
                        const href = trainerHorsesHref(row.id, row.horseCount);
                        // Justin, 2 Sep 2026: the count opens that trainer's horses.
                        return href ? (
                          <Link href={href} className="row-link" data-testid="trainer-horses-link">
                            {label}
                          </Link>
                        ) : (
                          label
                        );
                      })()}
                    </td>
                    <td className="nowrap">
                      {(() => {
                        const label = timeAgo(row.lastPostAt);
                        const href = trainerPostsHref(row.id, row.lastPostAt);
                        // The posts half of the two-way jump (ENG-963): from a
                        // trainer straight to their posts, as the horse count
                        // already jumps to their horses.
                        return href ? (
                          <Link href={href} className="row-link" data-testid="trainer-posts-link">
                            {label}
                          </Link>
                        ) : (
                          label
                        );
                      })()}
                    </td>
                    <td className="nowrap">
                      {row.status === "active" ? (
                        <span className="pill green dot">Active</span>
                      ) : (
                        <span className="pill amber dot">Onboarding</span>
                      )}
                      {/* ENG-766: published to the public stablepass.co strip. */}
                      {row.marketingVisible ? (
                        <span className="pill site" data-testid="on-site-badge">On site</span>
                      ) : null}
                    </td>
                    <td className="actions">
                      <Link href={`/trainers/${row.id}/edit`}>Edit</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {signedRows.length > 0 ? (
            // The row count the list has been missing: how many trainers the
            // ACTIVE filter matched, which is not `counts.all` (those tally the
            // whole roster for the chips).
            <div className="adm-table-foot" data-testid="trainers-count">
              {signedRows.length} {signedRows.length === 1 ? "trainer" : "trainers"}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
