// Per-post analytics (ENG-276) — built 1:1 against
// 06-stage1-design/mockups/web/admin/screens/10-post-analytics.html.
//
// Pure presentation over the A3 PostAnalytics payload.

import Link from "next/link";
import { EmojiBars, LineChart } from "../../Charts";
import { formatNumber, formatWeekdayLabel } from "../../chart";
import { typeLabel } from "../../AnalyticsScreen";
import type { PostAnalytics as PostAnalyticsData } from "@/lib/analytics/queries";

/** "2026-07-16T20:05:00Z" -> "Thu 16 Jul, 6:05am" (AEST, as the mockup shows). */
export function publishedLabel(iso: string | null): string {
  if (!iso) return "Not published";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Not published";
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const time = `${get("hour")}:${get("minute")}${get("dayPeriod").toLowerCase().replace(/\s/g, "")}`;
  return `Published ${get("weekday")} ${get("day")} ${get("month")}, ${time}`;
}

/** Saves as a share of opens, e.g. "4.7% of opens". */
function savesDelta(saves: number, opens: number): string {
  if (opens <= 0) return "no opens yet";
  return `${((saves / opens) * 100).toFixed(1)}% of opens`;
}

export default function PostAnalytics({ data }: { data: PostAnalyticsData }) {
  const { post } = data;
  const totalReactions = data.reactionsByEmoji.reduce((sum, r) => sum + r.count, 0);
  const meta = [post.horseName, post.trainerName, typeLabel(post.type)]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <div className="admin-topbar">
        <h1>
          <Link href="/analytics" className="back-link">
            ← Analytics
          </Link>
          &nbsp;·&nbsp; Post
        </h1>
        <div className="actions">
          {/* The posts library, per the mockup — NOT compose, which only
              hydrates photo/video posts and would land blank for a voice one. */}
          <Link href="/posts" className="btn btn-primary btn-md">
            Open in posts library
          </Link>
        </div>
      </div>

      <div className="admin-content">
        {/* Post header */}
        <div className="adm-card">
          <div className="post-hero" data-testid="post-hero">
            <div>
              <h2>{post.title || "Untitled post"}</h2>
              <div className="meta">
                {meta} · {publishedLabel(post.publishedAt)}
              </div>
            </div>
          </div>
        </div>

        {/* Tiles */}
        <div className="adm-stats adm-mt" data-testid="post-tiles">
          <div className="adm-stat">
            <div className="label">Opens</div>
            <div className="num">{formatNumber(data.opens)}</div>
            <div className="delta">first views since publish</div>
          </div>
          <div className="adm-stat">
            <div className="label">Reactions</div>
            <div className="num">{formatNumber(totalReactions)}</div>
            <div className="delta">positive-only set</div>
          </div>
          <div className="adm-stat">
            <div className="label">Saves</div>
            <div className="num">{formatNumber(data.saves)}</div>
            <div className="delta">{savesDelta(data.saves, data.opens)}</div>
          </div>
          <div className="adm-stat">
            <div className="label">Reached</div>
            <div className="num">{formatNumber(data.reach)}</div>
            <div className="delta">following this horse</div>
          </div>
        </div>

        <div className="adm-grid-2 even adm-mt">
          {/* Opens since publish */}
          <div className="adm-card">
            <div className="adm-card-head">
              <div>
                <h2>Opens since publish</h2>
                <div className="sub">First views per day.</div>
              </div>
            </div>
            <LineChart
              series={data.opensByDay.map((d) => ({
                label: formatWeekdayLabel(d.day),
                value: d.opens,
              }))}
              ariaLabel="Line chart: first views per day since publish"
              emptyMessage="No opens recorded for this post yet."
              testId="post-opens"
            />
          </div>

          {/* Reaction breakdown */}
          <div className="adm-card">
            <div className="adm-card-head">
              <div>
                <h2>Reactions by type</h2>
                <div className="sub">
                  {formatNumber(totalReactions)} total · positive-only set.
                </div>
              </div>
            </div>
            <EmojiBars
              rows={data.reactionsByEmoji}
              emptyMessage="No reactions on this post yet."
              testId="post-reactions"
            />
            <div className="chart-note">
              The reaction set follows whatever is enabled in the platform.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
