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
  /** The horse's newest published post, or none — an embed limited to 1 row. */
  posts?: PostRecency[] | null;
};

/**
 * Count subscriptions in one status, EXCLUDING staff, without fetching a row.
 *
 * Every signup gets a trial subscription — operators included, since an admin
 * is just an app_user promoted to `is_admin` after signup (ENG-315), so any
 * count over `subscription` has to drop staff rows. That rule is exactly why
 * this was a row fetch before: `{ count: "exact", head: true }` cannot filter
 * in JS. It does not have to — PostgREST filters on an embedded resource, and
 * `!inner` makes the embed a join so the filter reaches the parent count.
 *
 * `not.is.true` rather than `eq.false` deliberately: `is_admin` may be null,
 * and `eq.false` would drop a perfectly ordinary member whose flag was never
 * set — a member count that silently shrinks is worse than a slow one.
 */
async function countMembers(sb: SupabaseClient, status: string): Promise<number> {
  const { count } = await sb
    .from("subscription")
    .select("status,user:user_id!inner(is_admin)", { count: "exact", head: true })
    .eq("status", status)
    .not("user.is_admin", "is", true);
  return count ?? 0;
}

/**
 * The statuses a subscription can hold (api-contract.md: the Stripe webhook
 * writes active/canceled/lapsed; the trial-sweep writes lapsed). Needed because
 * a per-status count has to know which statuses to ask about — the old row
 * fetch discovered them from the data.
 */
export const SUBSCRIPTION_STATUSES = ["trial", "active", "lapsed", "canceled"] as const;

/** The single embedded post row a horse carries in the analytics read. */
type PostRecency = { published_at: string | null };
/** The flat `post` projection race-day still reads (it is already `.in()`-scoped). */
type HorsePostRecency = PostRecency & { horse_id: string };

function horseName(h: { racing_name: string | null; display_name: string }): string {
  return h.racing_name ?? h.display_name;
}

function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / (24 * HOUR_MS)));
}

export async function getAnalytics(sb: SupabaseClient, now: Date = new Date()): Promise<Analytics> {
  const weekAgo = weekAgoIso(now);

  const [postsRes, reactionsRes, savesRes, trialMembers, activeMembers, horsesRes] =
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
      // operator accounts. Two `head: true` counts: this used to fetch one row
      // per member subscription purely to run `.filter().length` over it.
      countMembers(sb, "trial"),
      countMembers(sb, "active"),
      // Active (visible) horses — the pool the quiet-horse check runs over —
      // each carrying its OWN newest published post, and nothing else.
      //
      // This replaces a read of EVERY published post in the database. The embed
      // is filtered to published rows (`posts.status`), ordered newest-first and
      // `.limit(1, { referencedTable })`-ed, so at most one post row travels per
      // horse. It is exactly equivalent to what the JS did: it took the first
      // row of the same descending order, and "posted this week" is true iff
      // that newest post is inside the window. `!inner` is deliberately NOT
      // used — a horse with no published post must still appear (that is the
      // whole point of a quiet-horse list), and an inner join would drop it.
      sb
        .from("horse")
        .select("id,display_name,racing_name,training_status,photo_url,posts:post(published_at)")
        .eq("status", "active")
        .eq("posts.status", "published")
        .order("published_at", { referencedTable: "posts", ascending: false, nullsFirst: false })
        .limit(1, { referencedTable: "posts" }),
    ]);

  const weekAgoMs = now.getTime() - WEEK_MS;
  const lastPostOf = (h: HorseRow): string | null => (h.posts ?? [])[0]?.published_at ?? null;

  const quietHorses: QuietHorse[] = ((horsesRes.data ?? []) as unknown as HorseRow[])
    // Compare as timestamps, not ISO strings, so a timezone-offset format
    // (`+00:00` vs `Z`) can't break the "posted this week" boundary check.
    .filter((h) => {
      const last = lastPostOf(h);
      return !(last && new Date(last).getTime() >= weekAgoMs);
    })
    .map((h) => ({
      id: h.id,
      name: horseName(h),
      daysSinceLastPost: daysSince(lastPostOf(h), now),
      trainingStatus: h.training_status,
      imageUrl: h.photo_url,
    }))
    // Longest-quiet first; never-posted (null) sinks to the bottom.
    .sort((a, b) => (b.daysSinceLastPost ?? -1) - (a.daysSinceLastPost ?? -1));

  return {
    postsThisWeek: postsRes.count ?? 0,
    reactions: reactionsRes.count ?? 0,
    saves: savesRes.count ?? 0,
    members: trialMembers + activeMembers,
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
    for (const p of (posts ?? []) as HorsePostRecency[]) {
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
  // One `head: true` count per status instead of one ROW per subscription. The
  // old version fetched every subscription in the system and tallied it in JS,
  // which is the same answer at a linearly growing cost.
  const wanted = status ? [status] : [...SUBSCRIPTION_STATUSES];
  const counts = await Promise.all(wanted.map((sName) => countMembers(sb, sName)));

  // Zero-count statuses stay ABSENT from `byStatus`, exactly as the tally-from-
  // rows version left them out — the subscribers route's response shape is
  // asserted key-for-key, and a `{ lapsed: 0 }` that never used to appear would
  // be a contract change dressed up as a performance fix.
  const byStatus: Record<string, number> = {};
  let total = 0;
  wanted.forEach((sName, i) => {
    total += counts[i];
    if (counts[i] > 0) byStatus[sName] = counts[i];
  });
  return { total, byStatus };
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
