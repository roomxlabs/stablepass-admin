// Analytics data helpers (ENG-275). Injectable query helpers each take the
// admin RLS client `sb` first so they unit-test against the fake. All rows
// come off Postgres RPCs (see the A1 migration) or direct table reads gated
// by admin SELECT policies. Aggregates only; per-endpoint PII rules are
// documented on each helper below.
//
// MEMBER-ONLY NUMBERS (ENG-984): every user-activity metric (opens,
// reactions, saves, website clicks, reach) is recomputed member-only from the
// raw engagement tables via `lib/analytics/admin-exclusion.ts`, rather than
// trusted from the `admin_*` RPCs, which count every row including
// operators'. STRUCTURE/CONTENT fields (entity ids, names, `posts`/`horses`
// counts) still come straight off the RPCs — see `admin-exclusion.ts` for the
// full rationale.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminUserIds, memberRows, countMemberRows } from "./admin-exclusion";

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

// `memberRows`/`countMemberRows` (admin-exclusion.ts) type their `shape`
// callback's parameter as the pre-`.select()` `PostgrestQueryBuilder`, which
// doesn't expose filter methods — the real (post-`.select()`) builder does.
// Cast through this minimal shape rather than `any` at every call site.
type Filterable = {
  gte(column: string, value: string): Filterable;
  eq(column: string, value: string): Filterable;
};
function filterable(q: unknown): Filterable {
  return q as Filterable;
}

// ---- Opens --------------------------------------------------------------------

type ImpressionRow = { user_id: string | null; seen_at: string };

export async function getOpens(sb: SupabaseClient, since: string | null): Promise<Opens> {
  const adminIds = await getAdminUserIds(sb);
  // Member-only (ENG-984): the `admin_opens_by_*` RPCs counted every open
  // including operators'. Bucketed here in TS, in UTC, to match the RPCs'
  // `at time zone 'UTC'` bucketing exactly.
  const rows = await memberRows<ImpressionRow>(
    sb,
    "impression",
    "user_id,seen_at",
    (q) => (since ? filterable(q).gte("seen_at", since) : q),
    adminIds,
  );

  const byDayMap = new Map<string, number>();
  const byHourMap = new Map<number, number>();
  for (const r of rows) {
    const d = new Date(r.seen_at);
    const day = d.toISOString().slice(0, 10);
    byDayMap.set(day, (byDayMap.get(day) ?? 0) + 1);
    const hour = d.getUTCHours();
    byHourMap.set(hour, (byHourMap.get(hour) ?? 0) + 1);
  }

  return {
    byDay: Array.from(byDayMap.entries())
      .map(([day, opens]) => ({ day, opens }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
    byHour: Array.from(byHourMap.entries())
      .map(([hour, opens]) => ({ hour, opens }))
      .sort((a, b) => a.hour - b.hour),
  };
}

// ---- Engagement -----------------------------------------------------------------

type EngagementPostEmbed = { id: string; source_trainer_id: string | null; horse_id: string | null };
type EngagementRow = {
  user_id: string | null;
  post: EngagementPostEmbed | EngagementPostEmbed[] | null;
};
type ClickRow = { user_id: string | null; trainer_id: string | null };

type Tally = { opens: number; reactions: number; saves: number };
function bumpTally(map: Map<string, Tally>, id: string | null, field: keyof Tally): void {
  if (id == null) return;
  const t = map.get(id) ?? { opens: 0, reactions: 0, saves: 0 };
  t[field] += 1;
  map.set(id, t);
}

export async function getEngagement(sb: SupabaseClient, since: string | null): Promise<Engagement> {
  const adminIds = await getAdminUserIds(sb);

  // Member-only (ENG-984): trainer/horse/post STRUCTURE (ids, names, `posts`/
  // `horses` counts) still comes off the RPC skeleton — that's content, not
  // member activity. `opens`/`reactions`/`saves`/`websiteClicks` are
  // recomputed member-only from the raw tables below and substituted in.
  // p_limit 100 (not 10) so re-ranking topPosts by member opens can't miss a
  // post that only looked top because of admin opens.
  const [trainerRows, horseRows, topPostRows] = await Promise.all([
    callRpc<TrainerEngagementRow>(sb, "admin_trainer_engagement", { p_since: since }),
    callRpc<HorseEngagementRow>(sb, "admin_horse_engagement", { p_since: since }),
    callRpc<TopPostRow>(sb, "admin_top_posts", { p_since: since, p_limit: 100 }),
  ]);

  const postEmbed = "post:post_id(id,source_trainer_id,horse_id)";
  const [imps, reacts, saves, clicks] = await Promise.all([
    memberRows<EngagementRow>(
      sb,
      "impression",
      `user_id,${postEmbed}`,
      (q) => (since ? filterable(q).gte("seen_at", since) : q),
      adminIds,
    ),
    memberRows<EngagementRow>(
      sb,
      "reaction",
      `user_id,${postEmbed}`,
      (q) => (since ? filterable(q).gte("created_at", since) : q),
      adminIds,
    ),
    memberRows<EngagementRow>(
      sb,
      "bookmark",
      `user_id,${postEmbed}`,
      (q) => (since ? filterable(q).gte("created_at", since) : q),
      adminIds,
    ),
    memberRows<ClickRow>(
      sb,
      "trainer_website_click",
      "user_id,trainer_id",
      (q) => (since ? filterable(q).gte("clicked_at", since) : q),
      adminIds,
    ),
  ]);

  const trainerTally = new Map<string, Tally>();
  const horseTally = new Map<string, Tally>();
  const postTally = new Map<string, Tally>();

  function tallyRows(rows: EngagementRow[], field: keyof Tally): void {
    for (const r of rows) {
      const post = one(r.post);
      if (!post) continue;
      bumpTally(trainerTally, post.source_trainer_id, field);
      bumpTally(horseTally, post.horse_id, field);
      bumpTally(postTally, post.id, field);
    }
  }
  tallyRows(imps, "opens");
  tallyRows(reacts, "reactions");
  tallyRows(saves, "saves");

  const clicksByTrainer = new Map<string, number>();
  for (const r of clicks) {
    if (r.trainer_id == null) continue;
    clicksByTrainer.set(r.trainer_id, (clicksByTrainer.get(r.trainer_id) ?? 0) + 1);
  }

  const zeroTally: Tally = { opens: 0, reactions: 0, saves: 0 };

  const trainers = trainerRows.map((r) => {
    const t = trainerTally.get(r.trainer_id) ?? zeroTally;
    return {
      trainerId: r.trainer_id,
      name: r.name,
      horses: Number(r.horses),
      posts: Number(r.posts),
      opens: t.opens,
      reactions: t.reactions,
      saves: t.saves,
      websiteClicks: clicksByTrainer.get(r.trainer_id) ?? 0,
    };
  });

  const horses = horseRows.map((r) => {
    const t = horseTally.get(r.horse_id) ?? zeroTally;
    return {
      horseId: r.horse_id,
      name: r.name,
      trainerName: r.trainer_name,
      posts: Number(r.posts),
      opens: t.opens,
      reactions: t.reactions,
      saves: t.saves,
    };
  });

  const topPosts = topPostRows
    .map((r) => {
      const t = postTally.get(r.post_id) ?? zeroTally;
      return {
        postId: r.post_id,
        title: r.title,
        horseName: r.horse_name,
        type: r.type,
        opens: t.opens,
        reactions: t.reactions,
        saves: t.saves,
      };
    })
    .sort((a, b) => b.opens - a.opens || (a.postId < b.postId ? -1 : a.postId > b.postId ? 1 : 0))
    .slice(0, 10);

  return { trainers, horses, topPosts };
}

// ---- Clicks -----------------------------------------------------------------
// Aggregates only — never include a user-level field (guardrail: no owner PII).

type TrainerClickRow = { user_id: string | null; trainer_id: string | null; clicked_at: string };

export async function getClicks(sb: SupabaseClient, since: string | null): Promise<Clicks> {
  const adminIds = await getAdminUserIds(sb);
  // `name` (and the trainer's presence in the list) still comes off the RPC —
  // it inner-joins clicks so a trainer with zero MEMBER clicks must be
  // dropped below, even though the RPC saw it as non-zero. `clicks` and
  // `lastClick` are recomputed member-only (ENG-984).
  const rpcRows = await callRpc<ClicksByTrainerRow>(sb, "admin_clicks_by_trainer", { p_since: since });
  const memberClickRows = await memberRows<TrainerClickRow>(
    sb,
    "trainer_website_click",
    "user_id,trainer_id,clicked_at",
    (q) => (since ? filterable(q).gte("clicked_at", since) : q),
    adminIds,
  );

  const byTrainer = new Map<string, { clicks: number; lastClick: string | null }>();
  for (const r of memberClickRows) {
    if (r.trainer_id == null) continue;
    const cur = byTrainer.get(r.trainer_id) ?? { clicks: 0, lastClick: null };
    cur.clicks += 1;
    if (cur.lastClick == null || r.clicked_at > cur.lastClick) cur.lastClick = r.clicked_at;
    byTrainer.set(r.trainer_id, cur);
  }

  return {
    trainers: rpcRows
      .map((r) => {
        const m = byTrainer.get(r.trainer_id) ?? { clicks: 0, lastClick: null };
        return { trainerId: r.trainer_id, name: r.name, clicks: m.clicks, lastClick: m.lastClick };
      })
      .filter((r) => r.clicks > 0),
  };
}

// ---- Trials -----------------------------------------------------------------

type SubscriptionUserEmbed = { name: string | null; email: string | null; is_admin?: boolean | null };
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

// Already member-only as of ENG-314 (the by-month RPC excludes admins in SQL,
// and the subscriptions list is filtered below) — left untouched by ENG-984.
export async function getTrials(sb: SupabaseClient): Promise<Trials> {
  const [byMonthRows, subsRes] = await Promise.all([
    callRpc<TrialsByMonthRow>(sb, "admin_trials_by_month"),
    sb
      .from("subscription")
      .select("status,trial_ends_at,created_at,user:user_id(name,email,is_admin)")
      .order("created_at", { ascending: false }),
  ]);

  // Every signup gets a trial subscription — including operators, who are just
  // app_user rows promoted to is_admin afterwards (ENG-314). The trials list /
  // CSV is member data, so staff accounts are filtered out here; the by-month
  // RPC applies the same exclusion BE-side.
  const rows = ((unwrap(subsRes, "trials subscriptions query") ?? []) as SubscriptionRow[]).filter(
    (r) => !one(r.user)?.is_admin,
  );

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

  // Member-only (ENG-984): opens, reactions, saves and reach are recomputed
  // from the raw engagement tables via admin-exclusion.ts, replacing the
  // `admin_post_opens_by_day` / `admin_post_reactions` RPCs and the raw
  // bookmark/follow head-counts, all of which counted operator activity.
  const adminIds = await getAdminUserIds(sb);
  const [opensRows, reactionRows, saves, reach] = await Promise.all([
    memberRows<ImpressionRow>(sb, "impression", "user_id,seen_at", (q) => filterable(q).eq("post_id", postId), adminIds),
    memberRows<{ user_id: string | null; emoji: string }>(
      sb,
      "reaction",
      "user_id,emoji",
      (q) => filterable(q).eq("post_id", postId),
      adminIds,
    ),
    countMemberRows(sb, "bookmark", (q) => filterable(q).eq("post_id", postId), adminIds),
    row.horse_id
      ? countMemberRows(sb, "follow", (q) => filterable(q).eq("horse_id", row.horse_id as string), adminIds)
      : Promise.resolve(0),
  ]);

  const byDayMap = new Map<string, number>();
  for (const r of opensRows) {
    const day = new Date(r.seen_at).toISOString().slice(0, 10);
    byDayMap.set(day, (byDayMap.get(day) ?? 0) + 1);
  }
  const opensByDay = Array.from(byDayMap.entries())
    .map(([day, opens]) => ({ day, opens }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const emojiMap = new Map<string, number>();
  for (const r of reactionRows) emojiMap.set(r.emoji, (emojiMap.get(r.emoji) ?? 0) + 1);
  const reactionsByEmoji = Array.from(emojiMap.entries()).map(([emoji, count]) => ({ emoji, count }));

  const opens = opensByDay.reduce((sum, r) => sum + r.opens, 0);

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
    saves,
    opens,
    reach,
  };
}
