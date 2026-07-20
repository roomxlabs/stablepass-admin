// View-model assembly for the admin Analytics screen (ENG-276).
//
// Reads through ENG-275's injectable query helpers on the caller's admin RLS
// client, so this file unit-tests against the Supabase fake. Kept out of the
// page component for exactly that reason (mirrors trainers/data.ts).
//
// Guardrail: no member-identifying data leaves this module EXCEPT the trials
// list, which is the one surface the epic decision allows to carry name/email
// (it exists to be exported to the mail tool).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getClicks,
  getEngagement,
  getOpens,
  getTrials,
  periodSince,
  type Engagement,
  type Period,
  type Trials,
} from "@/lib/analytics/queries";
import {
  formatDayLabel,
  formatMonthLabel,
  hourBuckets,
  type Series,
} from "./chart";

export type PeriodOption = { value: Period; label: string };

export const PERIOD_OPTIONS: PeriodOption[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "all", label: "All time" },
];

/** "30d" -> "30 days" — used in tile sub-labels and card sub-headings. */
export function periodLabel(period: Period): string {
  return PERIOD_OPTIONS.find((o) => o.value === period)?.label ?? period;
}

export type Tile = { label: string; value: string; delta: string };

export type AnalyticsView = {
  period: Period;
  tiles: Tile[];
  opensByDay: Series[];
  opensByHour: Series[];
  trialsByMonth: Series[];
  trials: Trials["list"];
  trialCount: number;
  trainers: TrainerRow[];
  horses: Engagement["horses"];
  topPosts: Engagement["topPosts"];
};

/** Engagement row merged with its click count from the clicks endpoint. */
export type TrainerRow = Engagement["trainers"][number] & { clicks: number };

function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0);
}

function formatCount(n: number): string {
  return n.toLocaleString("en-AU");
}

/**
 * The mockup's tiles carry period-over-period deltas ("+18% vs prior 30 days").
 * The A3 endpoints expose only the CURRENT period, so rather than fabricate a
 * comparison we render the honest sub-label the data supports. Wiring real
 * deltas needs a prior-period query on the BFF (not in this ticket's surface).
 */
function buildTiles(
  period: Period,
  opens: number,
  engagement: Engagement,
  trials: Trials,
): Tile[] {
  const label = periodLabel(period).toLowerCase();
  const onTrial = trials.list.filter((t) => t.status === "trial");
  const endingSoon = onTrial.filter((t) => t.daysLeft <= 7).length;
  const subscribers = trials.list.filter((t) => t.status === "active").length;
  const reactions = sum(engagement.trainers.map((t) => t.reactions));
  const saves = sum(engagement.trainers.map((t) => t.saves));

  return [
    // Subscribers and On-trial are point-in-time counts: getTrials() takes no
    // `since`, so these two do NOT move with the period toggle. Say "as of
    // today" so a reader scanning one row of five doesn't read all five as
    // period-scoped.
    {
      label: "Subscribers",
      value: formatCount(subscribers),
      delta: "active · as of today",
    },
    {
      label: "On trial",
      value: formatCount(onTrial.length),
      delta:
        endingSoon === 1
          ? "1 ends within 7 days · as of today"
          : `${endingSoon} end within 7 days · as of today`,
    },
    { label: "Opens", value: formatCount(opens), delta: `first views · ${label}` },
    { label: "Reactions", value: formatCount(reactions), delta: `across all posts · ${label}` },
    { label: "Saves", value: formatCount(saves), delta: `across all posts · ${label}` },
  ];
}

export async function getAnalyticsView(
  sb: SupabaseClient,
  period: Period,
): Promise<AnalyticsView> {
  const since = periodSince(period);

  const [opens, engagement, trials, clicks] = await Promise.all([
    getOpens(sb, since),
    getEngagement(sb, since),
    getTrials(sb),
    getClicks(sb, since),
  ]);

  // Website clicks come from their own endpoint; merge onto the engagement
  // rows so the trainer table has the mockup's Website clicks column.
  const clicksByTrainer = new Map(clicks.trainers.map((c) => [c.trainerId, c.clicks]));
  const trainers: TrainerRow[] = engagement.trainers.map((t) => ({
    ...t,
    // The engagement RPC also reports website_clicks; prefer the dedicated
    // clicks endpoint when it has a row, so both stay consistent.
    clicks: clicksByTrainer.get(t.trainerId) ?? t.websiteClicks,
  }));

  const totalOpens = sum(opens.byDay.map((d) => d.opens));

  return {
    period,
    tiles: buildTiles(period, totalOpens, engagement, trials),
    // The mockup shows the last 14 days on the by-day chart.
    opensByDay: opens.byDay
      .slice(-14)
      .map((d) => ({ label: formatDayLabel(d.day), value: d.opens })),
    opensByHour: hourBuckets(opens.byHour),
    trialsByMonth: trials.byMonth.map((m) => ({
      label: formatMonthLabel(m.month),
      value: m.started,
    })),
    trials: trials.list.filter((t) => t.status === "trial"),
    trialCount: trials.list.filter((t) => t.status === "trial").length,
    trainers,
    horses: engagement.horses,
    topPosts: engagement.topPosts,
  };
}

// ---- Date formatting for the trials table -----------------------------------

/** "2026-06-24T…" -> "24 Jun". Returns "—" for a null/invalid date. */
export function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getUTCDate()} ${
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
      d.getUTCMonth()
    ]
  }`;
}

/** Amber once a trial is inside its last 10 days, matching the mockup's pills
 *  (which amber 5 and 9 days left, and leave 17 and 26 neutral). */
export function daysLeftPillClass(daysLeft: number): string {
  return daysLeft <= 10 ? "pill amber" : "pill";
}
