// Analytics data helpers (ENG-275). Injectable query helpers each take the
// admin RLS client `sb` first so they unit-test against the fake. All rows
// come off Postgres RPCs (see the A1 migration) or direct table reads gated
// by admin SELECT policies. Aggregates only; per-endpoint PII rules are
// documented on each helper below.
import type { SupabaseClient } from "@supabase/supabase-js";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---- Period -----------------------------------------------------------------

export type Period = "7d" | "30d" | "all";
export const PERIODS = ["7d", "30d", "all"] as const;

// Returns the Period, or null if the raw value is present-but-invalid.
// An ABSENT param (null/undefined/"") defaults to "30d".
export function parsePeriod(raw: string | null): Period | null {
  if (raw == null || raw === "") return "30d";
  return (PERIODS as readonly string[]).includes(raw) ? (raw as Period) : null;
}

// "7d" -> ISO string 7 days ago; "30d" -> ISO 30 days ago; "all" -> null.
export function periodSince(p: Period): string | null {
  if (p === "all") return null;
  const days = p === "7d" ? 7 : 30;
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

// ---- Row types (snake_case, exactly as they come off PostgREST) ------------

type OpensByDayRow = { day: string; opens: number | string };
type OpensByHourRow = { hour: number | string; opens: number | string };
type TrainerEngagementRow = {
  trainer_id: string;
  name: string;
  horses: number | string;
  posts: number | string;
  opens: number | string;
  reactions: number | string;
  saves: number | string;
  website_clicks: number | string;
};
type HorseEngagementRow = {
  horse_id: string;
  name: string;
  trainer_name: string;
  posts: number | string;
  opens: number | string;
  reactions: number | string;
  saves: number | string;
};
type TopPostRow = {
  post_id: string;
  title: string;
  horse_name: string;
  type: string;
  opens: number | string;
  reactions: number | string;
  saves: number | string;
};
type TrialsByMonthRow = { month: string; started: number | string; converted: number | string };
type PostOpensByDayRow = { day: string; opens: number | string };
type PostReactionRow = { emoji: string; count: number | string };
type ClicksByTrainerRow = {
  trainer_id: string;
  name: string;
  clicks: number | string;
  last_click: string | null;
};

// ---- camelCase response types ------------------------------------------------

export type OpenByDay = { day: string; opens: number };
export type OpenByHour = { hour: number; opens: number };
export type Opens = { byDay: OpenByDay[]; byHour: OpenByHour[] };

export type TrainerEngagement = {
  trainerId: string;
  name: string;
  horses: number;
  posts: number;
  opens: number;
  reactions: number;
  saves: number;
  websiteClicks: number;
};
export type HorseEngagement = {
  horseId: string;
  name: string;
  trainerName: string;
  posts: number;
  opens: number;
  reactions: number;
  saves: number;
};
export type TopPost = {
  postId: string;
  title: string;
  horseName: string;
  type: string;
  opens: number;
  reactions: number;
  saves: number;
};
export type Engagement = {
  trainers: TrainerEngagement[];
  horses: HorseEngagement[];
  topPosts: TopPost[];
};

export type TrainerClicks = {
  trainerId: string;
  name: string;
  clicks: number;
  lastClick: string | null;
};
export type Clicks = { trainers: TrainerClicks[] };

export type TrialsByMonth = { month: string; started: number; converted: number };
export type TrialRow = {
  name: string;
  email: string;
  startedAt: string | null;
  endsAt: string | null;
  daysLeft: number;
  status: string;
};
export type Trials = { byMonth: TrialsByMonth[]; list: TrialRow[] };

export type PostAnalytics = {
  post: {
    id: string;
    title: string | null;
    horseName: string;
    trainerName: string;
    type: string;
    publishedAt: string | null;
  };
  opensByDay: OpenByDay[];
  reactionsByEmoji: { emoji: string; count: number }[];
  saves: number;
  opens: number;
  // reach = count of `follow` rows targeting the post's horse (unique per
  // user via `follow_no_duplicate`), i.e. how many people follow this horse.
  reach: number;
};

// ---- helpers ------------------------------------------------------------------

function one<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

async function callRpc<T>(sb: SupabaseClient, name: string, args?: Record<string, unknown>): Promise<T[]> {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(error.message);
  return (data ?? []) as T[];
}

// Table reads (unlike RPCs) don't throw on their own — every call site must
// check `error` explicitly so an RLS denial or broken query surfaces as a
// real failure instead of silently rendering as "no data".
function unwrap<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

// ---- Opens --------------------------------------------------------------------

export async function getOpens(sb: SupabaseClient, since: string | null): Promise<Opens> {
  const [byDayRows, byHourRows] = await Promise.all([
    callRpc<OpensByDayRow>(sb, "admin_opens_by_day", { p_since: since }),
    callRpc<OpensByHourRow>(sb, "admin_opens_by_hour", { p_since: since }),
  ]);

  return {
    byDay: byDayRows.map((r) => ({ day: r.day, opens: Number(r.opens) })),
    byHour: byHourRows.map((r) => ({ hour: Number(r.hour), opens: Number(r.opens) })),
  };
}

// ---- Engagement -----------------------------------------------------------------

export async function getEngagement(sb: SupabaseClient, since: string | null): Promise<Engagement> {
  const [trainerRows, horseRows, topPostRows] = await Promise.all([
    callRpc<TrainerEngagementRow>(sb, "admin_trainer_engagement", { p_since: since }),
    callRpc<HorseEngagementRow>(sb, "admin_horse_engagement", { p_since: since }),
    callRpc<TopPostRow>(sb, "admin_top_posts", { p_since: since, p_limit: 10 }),
  ]);

  return {
    trainers: trainerRows.map((r) => ({
      trainerId: r.trainer_id,
      name: r.name,
      horses: Number(r.horses),
      posts: Number(r.posts),
      opens: Number(r.opens),
      reactions: Number(r.reactions),
      saves: Number(r.saves),
      websiteClicks: Number(r.website_clicks),
    })),
    horses: horseRows.map((r) => ({
      horseId: r.horse_id,
      name: r.name,
      trainerName: r.trainer_name,
      posts: Number(r.posts),
      opens: Number(r.opens),
      reactions: Number(r.reactions),
      saves: Number(r.saves),
    })),
    topPosts: topPostRows.map((r) => ({
      postId: r.post_id,
      title: r.title,
      horseName: r.horse_name,
      type: r.type,
      opens: Number(r.opens),
      reactions: Number(r.reactions),
      saves: Number(r.saves),
    })),
  };
}

// ---- Clicks -----------------------------------------------------------------
// Aggregates only — never include a user-level field (guardrail: no owner PII).

export async function getClicks(sb: SupabaseClient, since: string | null): Promise<Clicks> {
  const rows = await callRpc<ClicksByTrainerRow>(sb, "admin_clicks_by_trainer", { p_since: since });
  return {
    trainers: rows.map((r) => ({
      trainerId: r.trainer_id,
      name: r.name,
      clicks: Number(r.clicks),
      lastClick: r.last_click,
    })),
  };
}

// ---- Trials -----------------------------------------------------------------

type SubscriptionUserEmbed = { name: string | null; email: string | null };
type SubscriptionRow = {
  status: string;
  trial_ends_at: string | null;
  created_at: string;
  user: SubscriptionUserEmbed | SubscriptionUserEmbed[] | null;
};

function daysLeft(trialEndsAt: string | null): number {
  if (!trialEndsAt) return 0;
  return Math.max(0, Math.ceil((Date.parse(trialEndsAt) - Date.now()) / DAY_MS));
}

export async function getTrials(sb: SupabaseClient): Promise<Trials> {
  const [byMonthRows, subsRes] = await Promise.all([
    callRpc<TrialsByMonthRow>(sb, "admin_trials_by_month"),
    sb
      .from("subscription")
      .select("status,trial_ends_at,created_at,user:user_id(name,email)")
      .order("created_at", { ascending: false }),
  ]);

  const rows = (unwrap(subsRes, "trials subscriptions query") ?? []) as SubscriptionRow[];

  return {
    byMonth: byMonthRows.map((r) => ({
      month: r.month,
      started: Number(r.started),
      converted: Number(r.converted),
    })),
    list: rows.map((r) => {
      const user = one(r.user);
      return {
        name: user?.name ?? "",
        email: user?.email ?? "",
        startedAt: r.created_at,
        endsAt: r.trial_ends_at,
        daysLeft: daysLeft(r.trial_ends_at),
        status: r.status,
      };
    }),
  };
}

// ---- Post analytics -----------------------------------------------------------

type PostHorseEmbed = { display_name: string | null; racing_name: string | null };
type PostTrainerEmbed = { name: string | null; display_name: string | null };
type PostRow = {
  id: string;
  title: string | null;
  type: string;
  published_at: string | null;
  horse_id: string | null;
  horse: PostHorseEmbed | PostHorseEmbed[] | null;
  trainer: PostTrainerEmbed | PostTrainerEmbed[] | null;
};

export async function getPostAnalytics(sb: SupabaseClient, postId: string): Promise<PostAnalytics | null> {
  const postRes = await sb
    .from("post")
    .select(
      "id,title,type,published_at,horse_id,horse:horse_id(display_name,racing_name),trainer:source_trainer_id(name,display_name)",
    )
    .eq("id", postId)
    .maybeSingle();

  const data = unwrap(postRes, "post query");
  if (!data) return null;
  const row = data as PostRow;
  const horse = one(row.horse);
  const trainer = one(row.trainer);

  const [opensByDayRows, reactionRows, savesRes, reachRes] = await Promise.all([
    callRpc<PostOpensByDayRow>(sb, "admin_post_opens_by_day", { p_post_id: postId }),
    callRpc<PostReactionRow>(sb, "admin_post_reactions", { p_post_id: postId }),
    sb.from("bookmark").select("*", { count: "exact", head: true }).eq("post_id", postId),
    row.horse_id
      ? sb.from("follow").select("*", { count: "exact", head: true }).eq("horse_id", row.horse_id)
      : Promise.resolve({ data: null, error: null, count: 0 }),
  ]);

  const opensByDay = opensByDayRows.map((r) => ({ day: r.day, opens: Number(r.opens) }));
  const reactionsByEmoji = reactionRows.map((r) => ({ emoji: r.emoji, count: Number(r.count) }));
  const opens = opensByDay.reduce((sum, r) => sum + r.opens, 0);

  unwrap(savesRes, "post saves count");
  unwrap(reachRes, "post reach count");

  return {
    post: {
      id: row.id,
      title: row.title,
      horseName: horse?.racing_name ?? horse?.display_name ?? "",
      trainerName: trainer?.display_name ?? trainer?.name ?? "",
      type: row.type,
      publishedAt: row.published_at,
    },
    opensByDay,
    reactionsByEmoji,
    saves: savesRes.count ?? 0,
    opens,
    reach: reachRes.count ?? 0,
  };
}
