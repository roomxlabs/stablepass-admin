import Link from "next/link";
import { supabaseServer } from "@/lib/supabase/server";
import { Icon } from "../icons";
import { listTrainers, timeAgo, type TrainerRow } from "./data";
import { TRAINER_PHOTO_BUCKET, signPhotoMap } from "@/lib/storage/photos";
import "./trainers.css";

// Trainers DB — list with All/Active/Onboarding filters, ?q= search over
// name/stable/location, horse count, last-post recency and roster status.
// Gated by the (dash) layout's requireAdminPage(): a non-admin never reaches it.
export const dynamic = "force-dynamic";

type Search = { status?: string; q?: string };

function chipHref(status: string | undefined, q: string | undefined): string {
  const p = new URLSearchParams();
  if (status) p.set("status", status);
  if (q) p.set("q", q);
  const qs = p.toString();
  return qs ? `/trainers?${qs}` : "/trainers";
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

  const sb = await supabaseServer();
  const { rows, counts } = await listTrainers(sb, { status, q });

  // Private bucket: sign each trainer's photo path for the avatar thumbnails.
  const trainerPhotos = await signPhotoMap(sb, TRAINER_PHOTO_BUCKET, rows.map((r) => r.photoUrl));
  const signedRows = rows.map((r) => ({
    ...r,
    photoUrl: r.photoUrl ? trainerPhotos.get(r.photoUrl) ?? null : null,
  }));

  const filtered = Boolean(status || q);

  return (
    <>
      <div className="admin-topbar">
        <h1>Trainers</h1>
        <div className="actions">
          <form className="search wide" method="get" action="/trainers">
            <Icon name="search" />
            {status ? <input type="hidden" name="status" value={status} /> : null}
            <input name="q" defaultValue={q ?? ""} placeholder="Search trainers…" aria-label="Search trainers" />
          </form>
          <Link href="/trainers/new" className="btn btn-primary" style={{ padding: "8px 16px", fontSize: "13.5px" }}>
            + Add trainer
          </Link>
        </div>
      </div>

      <div className="admin-content">
        <div className="adm-card">
          <div className="adm-filter-bar">
            <Link href={chipHref(undefined, q)} className={!status ? "chip active" : "chip"}>
              All <strong>{counts.all}</strong>
            </Link>
            <Link href={chipHref("active", q)} className={status === "active" ? "chip active" : "chip"}>
              Active <strong>{counts.active}</strong>
            </Link>
            <Link href={chipHref("onboarding", q)} className={status === "onboarding" ? "chip active" : "chip"}>
              Onboarding <strong>{counts.onboarding}</strong>
            </Link>
            <div className="spacer" />
            <form className="search-mini" method="get" action="/trainers">
              <Icon name="search" />
              {status ? <input type="hidden" name="status" value={status} /> : null}
              <input name="q" defaultValue={q ?? ""} placeholder="Filter by stable or location…" aria-label="Filter trainers" />
            </form>
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
                  <th style={{ width: "28%" }}>Trainer</th>
                  <th>Stable</th>
                  <th className="nowrap">Horses</th>
                  <th className="nowrap">Last post</th>
                  <th className="nowrap">Status</th>
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
                      <strong>{row.horseCount}</strong> {row.horseCount === 1 ? "horse" : "horses"}
                    </td>
                    <td className="nowrap">{timeAgo(row.lastPostAt)}</td>
                    <td className="nowrap">
                      {row.status === "active" ? (
                        <span className="pill green dot">Active</span>
                      ) : (
                        <span className="pill amber dot">Onboarding</span>
                      )}
                    </td>
                    <td className="actions">
                      <Link href={`/trainers/${row.id}/edit`}>Edit</Link>
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
