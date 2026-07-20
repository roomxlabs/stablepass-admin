// The Analytics screen (ENG-276) — built 1:1 against
// 06-stage1-design/mockups/web/admin/screens/09-analytics.html.
//
// Pure presentation over an AnalyticsView: no data access, no client state, so
// it renders in a jsdom component test as-is. The period toggle is plain links
// (?period=) — the server component refetches, matching the ticket.

import Link from "next/link";
import { BarChart } from "./Charts";
import { formatNumber, HOUR_TZ_LABEL } from "./chart";
import {
  PERIOD_OPTIONS,
  daysLeftPillClass,
  periodLabel,
  shortDate,
  type AnalyticsView,
} from "./data";
import type { Period } from "@/lib/analytics/queries";

function PeriodToggle({ period }: { period: Period }) {
  return (
    <div className="period-toggle" data-testid="period-toggle">
      {PERIOD_OPTIONS.map((o) => (
        <Link
          key={o.value}
          href={`/analytics?period=${o.value}`}
          className={o.value === period ? "active" : undefined}
          aria-current={o.value === period ? "page" : undefined}
        >
          {o.label}
        </Link>
      ))}
    </div>
  );
}

export default function AnalyticsScreen({ view }: { view: AnalyticsView }) {
  const label = periodLabel(view.period).toLowerCase();

  return (
    <>
      <div className="admin-topbar">
        <h1>Analytics</h1>
        <div className="actions">
          <PeriodToggle period={view.period} />
        </div>
      </div>

      <div className="admin-content">
        {/* Summary tiles for the selected period */}
        <div className="adm-stats five" data-testid="analytics-tiles">
          {view.tiles.map((t) => (
            <div className="adm-stat" key={t.label}>
              <div className="label">{t.label}</div>
              <div className="num">{t.value}</div>
              <div className="delta">{t.delta}</div>
            </div>
          ))}
        </div>

        {/* When members open content */}
        <div className="adm-grid-2">
          <div className="adm-card">
            <div className="adm-card-head">
              <div>
                <h2>Opens by day</h2>
                <div className="sub">First views of posts, each day · last 14 shown.</div>
              </div>
            </div>
            <BarChart
              series={view.opensByDay}
              ariaLabel="Bar chart: post opens per day over the last 14 days"
              emptyMessage="No opens recorded in this period yet."
              testId="opens-by-day"
            />
          </div>

          <div className="adm-card">
            <div className="adm-card-head">
              <div>
                <h2>Opens by time of day</h2>
                <div className="sub">
                  When members first see content · {HOUR_TZ_LABEL}.
                </div>
              </div>
            </div>
            <BarChart
              series={view.opensByHour}
              ariaLabel="Bar chart: post opens by hour of day"
              emptyMessage="Not enough opens yet to show a daily rhythm."
              testId="opens-by-hour"
            />
          </div>
        </div>

        {/* Trials */}
        <div className="adm-grid-2 adm-mt">
          <div className="adm-card">
            <div className="adm-card-head">
              <div>
                <h2>New trials by month</h2>
                <div className="sub">30-day trials started each month.</div>
              </div>
            </div>
            <BarChart
              series={view.trialsByMonth}
              ariaLabel="Bar chart: new trials started per month"
              emptyMessage="No trials started yet."
              testId="trials-by-month"
            />
          </div>

          <div className="adm-card">
            <div className="adm-card-head">
              <div>
                <h2>
                  Members on trial{" "}
                  <span className="pill" style={{ marginLeft: "6px" }}>
                    {formatNumber(view.trialCount)}
                  </span>
                </h2>
                <div className="sub">Who is on trial and how long they have left.</div>
              </div>
              <a
                href="/api/admin/analytics/trials?format=csv"
                className="btn btn-primary btn-sm"
                data-testid="trials-csv"
                download
              >
                Download CSV
              </a>
            </div>

            {view.trials.length === 0 ? (
              <div className="chart-empty" data-testid="trials-empty">
                Nobody is on trial right now.
              </div>
            ) : (
              <table className="adm-table" data-testid="trials-table">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Started</th>
                    <th>Ends</th>
                    <th className="num">Days left</th>
                  </tr>
                </thead>
                <tbody>
                  {view.trials.map((t) => (
                    <tr key={`${t.email}-${t.startedAt}`}>
                      <td>
                        <div className="row-name">{t.name || "—"}</div>
                        <div className="row-sub">{t.email}</div>
                      </td>
                      <td>{shortDate(t.startedAt)}</td>
                      <td>{shortDate(t.endsAt)}</td>
                      <td className="num">
                        <span className={daysLeftPillClass(t.daysLeft)}>{t.daysLeft}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="chart-note pad-top">
              CSV includes name, email, trial start and end, status. For your mail tool.
            </div>
          </div>
        </div>

        {/* Engagement by trainer */}
        <div className="adm-card adm-mt">
          <div className="adm-card-head">
            <div>
              <h2>Engagement by trainer</h2>
              <div className="sub">
                Which trainers are getting the most engagement · {label}.
              </div>
            </div>
          </div>

          {view.trainers.length === 0 ? (
            <div className="chart-empty" data-testid="trainers-empty">
              No trainer engagement in this period yet.
            </div>
          ) : (
            <table className="adm-table" data-testid="trainer-engagement">
              <thead>
                <tr>
                  <th>Trainer</th>
                  <th className="num">Posts</th>
                  <th className="num">Opens</th>
                  <th className="num">Reactions</th>
                  <th className="num">Saves</th>
                  <th className="num">Website clicks</th>
                </tr>
              </thead>
              <tbody>
                {view.trainers.map((t) => (
                  <tr key={t.trainerId}>
                    <td>
                      <div className="row-name">{t.name}</div>
                      <div className="row-sub">
                        {t.horses} {t.horses === 1 ? "horse" : "horses"} on platform
                      </div>
                    </td>
                    <td className="num">{formatNumber(t.posts)}</td>
                    <td className="num">{formatNumber(t.opens)}</td>
                    <td className="num">
                      <strong>{formatNumber(t.reactions)}</strong>
                    </td>
                    <td className="num">{formatNumber(t.saves)}</td>
                    <td className="num">{formatNumber(t.clicks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="chart-note pad-top">
            <span className="aggregate-note">
              Website clicks are counts only · per-account detail pending the compliance check
            </span>
          </div>
        </div>

        {/* Engagement by horse + top posts */}
        <div className="adm-grid-2 even adm-mt">
          <div className="adm-card">
            <div className="adm-card-head">
              <div>
                <h2>Engagement by horse</h2>
                <div className="sub">Top horses · {label}.</div>
              </div>
            </div>

            {view.horses.length === 0 ? (
              <div className="chart-empty" data-testid="horses-empty">
                No horse engagement in this period yet.
              </div>
            ) : (
              <table className="adm-table" data-testid="horse-engagement">
                <thead>
                  <tr>
                    <th>Horse</th>
                    <th className="num">Posts</th>
                    <th className="num">Opens</th>
                    <th className="num">Reactions</th>
                    <th className="num">Saves</th>
                  </tr>
                </thead>
                <tbody>
                  {view.horses.map((h) => (
                    <tr key={h.horseId}>
                      <td>
                        <div className="row-name">{h.name}</div>
                        <div className="row-sub">{h.trainerName}</div>
                      </td>
                      <td className="num">{formatNumber(h.posts)}</td>
                      <td className="num">{formatNumber(h.opens)}</td>
                      <td className="num">
                        <strong>{formatNumber(h.reactions)}</strong>
                      </td>
                      <td className="num">{formatNumber(h.saves)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="adm-card">
            <div className="adm-card-head">
              <div>
                <h2>Top posts</h2>
                <div className="sub">Most engaged posts · {label}. Click for post analytics.</div>
              </div>
            </div>

            {view.topPosts.length === 0 ? (
              <div className="chart-empty" data-testid="top-posts-empty">
                No posts have been opened in this period yet.
              </div>
            ) : (
              <table className="adm-table" data-testid="top-posts">
                <thead>
                  <tr>
                    <th>Post</th>
                    <th className="num">Opens</th>
                    <th className="num">Reactions</th>
                  </tr>
                </thead>
                <tbody>
                  {view.topPosts.map((p) => (
                    <tr key={p.postId}>
                      <td>
                        <div className="row-name">
                          <Link href={`/analytics/posts/${p.postId}`}>
                            {p.title || "Untitled post"}
                          </Link>
                        </div>
                        <div className="row-sub">
                          {p.horseName} · {typeLabel(p.type)}
                        </div>
                      </td>
                      <td className="num">{formatNumber(p.opens)}</td>
                      <td className="num">
                        <strong>{formatNumber(p.reactions)}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** "video" -> "Video". The set is open-ended, so this is a plain title-case. */
export function typeLabel(type: string): string {
  if (!type) return "Post";
  return type.charAt(0).toUpperCase() + type.slice(1);
}
