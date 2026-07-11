import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/admin";
import {
  getAnalytics,
  getRaceDay,
  getRecentlyPublished,
  type QuietHorse,
  type RaceRunner,
} from "@/lib/dashboard/queries";
import { Icon } from "./icons";
import "./dashboard.css";

// Dashboard landing — screens/02-dashboard.html. Data-bearing (dash) page: it
// re-asserts requireAdminPage() rather than trusting the layout gate (Next
// renders layout + page in parallel and caches the layout across soft nav, so
// the page must gate its own reads — see .rx/gotchas.md). Tiles + quiet horses
// come from the same helpers the /api/admin/analytics endpoint serves; the
// race-day queue from /api/admin/race-day; recently-published reuses T5's
// published-posts shape (read-only).

const RACE_WINDOW_HOURS = 24;

const fmt = (n: number) => n.toLocaleString("en-US");

function raceTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")}${ampm}`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function racePill(runner: RaceRunner): { cls: string; text: string } {
  if (!runner.hasPost || !runner.lastPostAt) return { cls: "pill amber dot", text: "No post yet" };
  const hrs = (Date.now() - new Date(runner.lastPostAt).getTime()) / 3_600_000;
  if (hrs < 24) return { cls: "pill green dot", text: `Posted ${timeAgo(runner.lastPostAt)}` };
  return { cls: "pill", text: `Last post · ${timeAgo(runner.lastPostAt)}` };
}

function raceMeta(trainer: string | null, venue: string | null, raceNumber: number | null, raceClass: string | null): string {
  const parts: string[] = [];
  if (trainer) parts.push(`by ${trainer}`);
  const place = [venue, raceNumber ? `R${raceNumber}` : null].filter(Boolean).join(" ");
  if (place) parts.push(place);
  if (raceClass) parts.push(raceClass);
  return parts.join(" · ");
}

function quietAge(h: QuietHorse): string {
  const age = h.daysSinceLastPost == null ? "never posted" : `${h.daysSinceLastPost}d`;
  return h.trainingStatus === "retired" ? `${age} · retired` : age;
}

const typeLabel = (t: string) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : "Post");

export default async function DashboardPage() {
  const { sb } = await requireAdminPage();

  const [analytics, races, recent] = await Promise.all([
    getAnalytics(sb),
    getRaceDay(sb, RACE_WINDOW_HOURS),
    getRecentlyPublished(sb, 5),
  ]);

  // Flatten races → one queue row per running horse (matches the mockup rows).
  const queue = races.flatMap((r) =>
    r.runners.map((runner) => ({ race: r, runner, key: `${r.id}:${runner.horseId}` })),
  );

  return (
    <>
      <div className="admin-topbar">
        <h1>Dashboard</h1>
        <div className="actions">
          <div className="search">
            <Icon name="search" /> Search posts, horses, trainers…
          </div>
          <Link href="/compose" className="btn btn-primary" style={{ padding: "8px 16px", fontSize: "13.5px" }}>
            + New post
          </Link>
        </div>
      </div>

      <div className="admin-content">
        {/* Tiles ------------------------------------------------------ */}
        <div className="adm-stats">
          <div className="adm-stat">
            <div className="label">Posts this week</div>
            <div className="num">{fmt(analytics.postsThisWeek)}</div>
            <div className="delta">published in the last 7 days</div>
          </div>
          <div className="adm-stat">
            <div className="label">Reactions</div>
            <div className="num">{fmt(analytics.reactions)}</div>
            <div className="delta">this week</div>
          </div>
          <div className="adm-stat">
            <div className="label">Saves</div>
            <div className="num">{fmt(analytics.saves)}</div>
            <div className="delta">this week</div>
          </div>
          <div className="adm-stat">
            <div className="label">Members</div>
            <div className="num">{fmt(analytics.members)}</div>
            <div className="delta muted">subscribers + trials</div>
          </div>
        </div>

        {/* Race day + quiet horses ----------------------------------- */}
        <div className="adm-grid-2">
          <div className="adm-card">
            <div className="adm-card-head">
              <div>
                <h2>Race day · today</h2>
                <div className="sub">Horses racing in the next 24h. Worth a pre-race post.</div>
              </div>
              <Link href="/compose" className="btn btn-primary" style={{ padding: "7px 14px", fontSize: "12.5px" }}>
                + New post
              </Link>
            </div>
            {queue.length === 0 ? (
              <div className="adm-empty">No platform horses racing in the next 24 hours.</div>
            ) : (
              queue.map(({ race, runner, key }) => {
                const pill = racePill(runner);
                return (
                  <div className="adm-race-row" key={key}>
                    <div className="time">{raceTime(race.scheduledAt)}</div>
                    <div>
                      <div className="horse-name">{runner.name}</div>
                      <div className="horse-meta">
                        {raceMeta(runner.trainer, race.venue, race.raceNumber, race.raceClass)}
                      </div>
                    </div>
                    <span className={pill.cls}>{pill.text}</span>
                    <Link href="/compose" className="adm-link">
                      Post
                    </Link>
                  </div>
                );
              })
            )}
          </div>

          <div className="adm-card">
            <div className="adm-card-head tight">
              <div>
                <h2>
                  Quiet horses{" "}
                  {analytics.quietHorses.length > 0 && (
                    <span className="pill amber">{analytics.quietHorses.length}</span>
                  )}
                </h2>
                <div className="sub">No post in the last 7 days.</div>
              </div>
              <Link href="/horses" className="adm-link sm">
                View all
              </Link>
            </div>
            {analytics.quietHorses.length === 0 ? (
              <div className="adm-empty">Every active horse has posted this week. 🎉</div>
            ) : (
              analytics.quietHorses.slice(0, 6).map((h) => (
                <div className="adm-quiet-row" key={h.id}>
                  <div className="adm-quiet-thumb">
                    {h.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- remote Storage photo; mockup uses a plain thumb img
                      <img src={h.imageUrl} alt="" />
                    ) : (
                      <Icon name="horseHead" />
                    )}
                  </div>
                  <div>
                    <div className="horse-name">
                      {h.name}
                      <span className="age">{quietAge(h)}</span>
                    </div>
                  </div>
                  <Link href="/compose" className="adm-link sm">
                    Post
                  </Link>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recently published ---------------------------------------- */}
        <div className="adm-card spaced">
          <div className="adm-card-head">
            <div>
              <h2>Recently published</h2>
              <div className="sub">What members are seeing.</div>
            </div>
            <Link href="/posts" className="adm-link">
              View library →
            </Link>
          </div>
          {recent.length === 0 ? (
            <div className="adm-empty">No published posts yet.</div>
          ) : (
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Post</th>
                  <th>Horse</th>
                  <th>Trainer</th>
                  <th>Published</th>
                  <th>Engagement</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {recent.map((p) => (
                  <tr key={p.id}>
                    <td className="with-thumb">
                      <div className="row-thumb">
                        <Icon name={p.type === "video" ? "play" : "bookmark"} />
                      </div>
                      <div>
                        <div className="row-name">{p.title ?? "Untitled post"}</div>
                        <div className="row-sub">{typeLabel(p.type)}</div>
                      </div>
                    </td>
                    <td>{p.horse ?? "—"}</td>
                    <td>{p.trainer ?? "—"}</td>
                    <td>{timeAgo(p.publishedAt)}</td>
                    <td>
                      <strong>{fmt(p.likeCount)}</strong> reactions
                    </td>
                    <td className="actions">
                      <Link href="/posts">Edit</Link>
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
