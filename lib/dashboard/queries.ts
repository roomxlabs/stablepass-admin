// Dashboard data helpers (ENG-174 / T4). Shared by the three dashboard route
// handlers (app/api/admin/{analytics,race-day,subscribers}/route.ts) AND the
// dashboard page (app/(dash)/page.tsx) so both read the exact same aggregates
// from one place. Every caller passes in the admin RLS client from its own
// gate (requireAdmin / requireAdminPage) — these helpers never construct a
// client and never touch a service-role key. Aggregates only; no owner PII.
import type { SupabaseClient } from "@supabase/supabase-js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export function weekAgoIso(now: Date = new Date()): string {
  return new Date(now.getTime() - WEEK_MS).toISOString();
}

// ---- Analytics (tiles + quiet horses) --------------------------------------

export type QuietHorse = {
  id: string;
  name: string;
  daysSinceLastPost: number | null; // null = never posted
  trainingStatus: string | null;
  imageUrl: string | null;
};

export type Analytics = {
  postsThisWeek: number; // published_at within 7d
  reactions: number; // reaction rows created within 7d
  saves: number; // bookmark rows created within 7d
  members: number; // subscriptions with status in {trial, active}
  quietHorses: QuietHorse[]; // active horses with no published post in 7d
};

type HorseRow = {
  id: string;
  display_name: string;
  racing_name: string | null;
  training_status: string | null;
  photo_url: string | null;
};

// Every signup gets a trial subscription — operators included, since an admin
// is an app_user promoted to is_admin after signup (ENG-315). Any "members"
// count over `subscription` must therefore exclude staff rows. PostgREST
// returns a to-one embed as an object or a 1-element array.
type SubscriptionUserEmbed = { is_admin?: boolean | null };
type SubscriptionWithUser = { status: string; user: SubscriptionUserEmbed | SubscriptionUserEmbed[] | null };
function isStaff(user: SubscriptionWithUser["user"]): boolean {
  return !!(Array.isArray(user) ? user[0] : user)?.is_admin;
}
type PostRecency = { horse_id: string; published_at: string | null };

function horseName(h: { racing_name: string | null; display_name: string }): string {
  return h.racing_name ?? h.display_name;
}

function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / (24 * HOUR_MS)));
}

export async function getAnalytics(sb: SupabaseClient, now: Date = new Date()): Promise<Analytics> {
  const weekAgo = weekAgoIso(now);

  const [postsRes, reactionsRes, savesRes, membersRes, horsesRes, recentPostsRes] =
    await Promise.all([
      // Posts published in the last 7 days.
      sb
        .from("post")
        .select("id", { count: "exact", head: true })
        .eq("status", "published")
        .gte("published_at", weekAgo),
      // Reactions created in the last 7 days.
      sb
        .from("reaction")
        .select("post_id", { count: "exact", head: true })
        .gte("created_at", weekAgo),
      // Saves (bookmarks) created in the last 7 days.
      sb
        .from("bookmark")
        .select("post_id", { count: "exact", head: true })
        .gte("created_at", weekAgo),
      // Members = subscriptions currently in trial or active, excluding
      // operator accounts (see isStaff above). Row fetch instead of a head
      // count so the staff filter can apply; the embed carries no PII.
      sb
        .from("subscription")
        .select("status,user:user_id(is_admin)")
        .in("status", ["trial", "active"]),
      // Active (visible) horses — the pool the quiet-horse check runs over.
      sb
        .from("horse")
        .select("id,display_name,racing_name,training_status,photo_url")
        .eq("status", "active"),
      // Published posts, newest first — used to derive each horse's last-post
      // recency and whether it posted within the window (one query, no N+1).
      sb
        .from("post")
        .select("horse_id,published_at")
        .eq("status", "published")
        .order("published_at", { ascending: false }),
    ]);

  const weekAgoMs = now.getTime() - WEEK_MS;
  const lastPostByHorse = new Map<string, string | null>();
  const postedThisWeek = new Set<string>();
  for (const p of (recentPostsRes.data ?? []) as PostRecency[]) {
    if (!lastPostByHorse.has(p.horse_id)) lastPostByHorse.set(p.horse_id, p.published_at);
    // Compare as timestamps, not ISO strings, so a timezone-offset format
    // (`+00:00` vs `Z`) can't break the "posted this week" boundary check.
    if (p.published_at && new Date(p.published_at).getTime() >= weekAgoMs) {
      postedThisWeek.add(p.horse_id);
    }
  }

  const quietHorses: QuietHorse[] = ((horsesRes.data ?? []) as HorseRow[])
    .filter((h) => !postedThisWeek.has(h.id))
    .map((h) => ({
      id: h.id,
      name: horseName(h),
      daysSinceLastPost: daysSince(lastPostByHorse.get(h.id) ?? null, now),
      trainingStatus: h.training_status,
      imageUrl: h.photo_url,
    }))
    // Longest-quiet first; never-posted (null) sinks to the bottom.
    .sort((a, b) => (b.daysSinceLastPost ?? -1) - (a.daysSinceLastPost ?? -1));

  return {
    postsThisWeek: postsRes.count ?? 0,
    reactions: reactionsRes.count ?? 0,
    saves: savesRes.count ?? 0,
    members: ((membersRes.data ?? []) as SubscriptionWithUser[]).filter((r) => !isStaff(r.user))
      .length,
    quietHorses,
  };
}

// ---- Race day (content queue) ----------------------------------------------

export type RaceRunner = {
  horseId: string;
  name: string;
  trainer: string | null;
  lastPostAt: string | null;
  hasPost: boolean;
};
export type RaceDayRace = {
  id: string;
  venue: string | null;
  raceNumber: number | null;
  raceClass: string | null;
  scheduledAt: string | null;
  runners: RaceRunner[];
};

type TrainerEmbed = { name: string | null; display_name: string | null };
type RaceHorseEmbed = {
  horse_id: string;
  horse:
    | {
        display_name: string | null;
        racing_name: string | null;
        trainer: TrainerEmbed | TrainerEmbed[] | null;
      }
    | null;
};
type RaceRow = {
  id: string;
  venue: string | null;
  race_number: number | null;
  race_class: string | null;
  scheduled_at: string | null;
  race_horse: RaceHorseEmbed[] | null;
};

function one<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export function parseWindowHours(raw: string | null | undefined): number {
  if (!raw) return 24;
  const m = /^\s*(\d+)\s*h?\s*$/i.exec(raw);
  const n = m ? parseInt(m[1], 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 24;
  return Math.min(n, 168); // cap at 7 days
}

export async function getRaceDay(
  sb: SupabaseClient,
  windowHours = 24,
  now: Date = new Date(),
): Promise<RaceDayRace[]> {
  const from = now.toISOString();
  const to = new Date(now.getTime() + windowHours * HOUR_MS).toISOString();

  const { data: races } = await sb
    .from("race")
    .select(
      "id,venue,race_number,race_class,scheduled_at,race_horse(horse_id,horse:horse_id(display_name,racing_name,trainer:trainer_id(name,display_name)))",
    )
    .eq("status", "upcoming")
    .gte("scheduled_at", from)
    .lte("scheduled_at", to)
    .order("scheduled_at", { ascending: true });

  // Cast through unknown: with no generated DB types, supabase-js infers the
  // embedded to-one `horse` as an array from the select string, which doesn't
  // structurally overlap our to-one RaceRow shape.
  const rows = (races ?? []) as unknown as RaceRow[];

  const horseIds = Array.from(
    new Set(rows.flatMap((r) => (r.race_horse ?? []).map((rh) => rh.horse_id))),
  );

  const lastPostByHorse = new Map<string, string>();
  if (horseIds.length) {
    const { data: posts } = await sb
      .from("post")
      .select("horse_id,published_at")
      .eq("status", "published")
      .in("horse_id", horseIds)
      .order("published_at", { ascending: false });
    for (const p of (posts ?? []) as PostRecency[]) {
      if (p.published_at && !lastPostByHorse.has(p.horse_id)) {
        lastPostByHorse.set(p.horse_id, p.published_at);
      }
    }
  }

  return rows.map((r) => ({
    id: r.id,
    venue: r.venue,
    raceNumber: r.race_number,
    raceClass: r.race_class,
    scheduledAt: r.scheduled_at,
    runners: (r.race_horse ?? []).map((rh) => {
      const horse = rh.horse;
      const trainer = one(horse?.trainer);
      const lastPostAt = lastPostByHorse.get(rh.horse_id) ?? null;
      return {
        horseId: rh.horse_id,
        name: horse ? horseName({ racing_name: horse.racing_name, display_name: horse.display_name ?? "" }) : "Unknown horse",
        trainer: trainer?.display_name ?? trainer?.name ?? null,
        lastPostAt,
        hasPost: lastPostAt != null,
      };
    }),
  }));
}

// ---- Subscribers (member drill-in) -----------------------------------------

export type Subscribers = {
  total: number;
  byStatus: Record<string, number>;
};

// Aggregate counts by subscription status. Selects only the `status` column and
// returns tallies — never a user_id or any member-identifying field (guardrail
// §4: aggregates only, no PII). `status` narrows to a single status when given.
export async function getSubscribers(
  sb: SupabaseClient,
  status?: string | null,
): Promise<Subscribers> {
  let q = sb.from("subscription").select("status,user:user_id(is_admin)");
  if (status) q = q.eq("status", status);
  const { data } = await q;
  // Staff excluded (ENG-315); only `status` is tallied — still no member PII.
  const rows = ((data ?? []) as SubscriptionWithUser[]).filter((r) => !isStaff(r.user));
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return { total: rows.length, byStatus };
}

// ---- Recently published (dashboard table; reuses T5's published shape) ------

export type RecentPost = {
  id: string;
  title: string | null;
  type: string;
  publishedAt: string | null;
  likeCount: number;
  horse: string | null;
  trainer: string | null;
};

type RecentPostRow = {
  id: string;
  title: string | null;
  type: string;
  published_at: string | null;
  like_count: number | null;
  horse: { display_name: string | null; racing_name: string | null } | { display_name: string | null; racing_name: string | null }[] | null;
  trainer: { name: string | null } | { name: string | null }[] | null;
};

// Read-only consume of the published-posts shape (owned by T5). Kept as a plain
// server-side read so the dashboard page never has to fetch its own API route;
// T5's files are untouched.
export async function getRecentlyPublished(sb: SupabaseClient, limit = 5): Promise<RecentPost[]> {
  const { data } = await sb
    .from("post")
    .select(
      "id,title,type,published_at,like_count,horse:horse_id(display_name,racing_name),trainer:source_trainer_id(name)",
    )
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(limit);

  return ((data ?? []) as RecentPostRow[]).map((p) => {
    const horse = one(p.horse);
    const trainer = one(p.trainer);
    return {
      id: p.id,
      title: p.title,
      type: p.type,
      publishedAt: p.published_at,
      likeCount: p.like_count ?? 0,
      horse: horse ? (horse.racing_name ?? horse.display_name) : null,
      trainer: trainer?.name ?? null,
    };
  });
}
