import type { SupabaseClient } from "@supabase/supabase-js";
import { compareValues, type SortDir } from "../list-href";

// Server-side data access for the admin Trainers list. Kept out of the page
// component so it can be unit-tested against the Supabase fake. Uses flat,
// per-table queries (no PostgREST embedding) merged in JS — deriving horse
// count, last-post recency and the primary internal contact per trainer.
//
// trainer_contact is ADMIN-ONLY (guardrail §3): its email is read here only to
// render the admin-gated list, never on any member surface.

export type TrainerStatus = "active" | "onboarding";

export type TrainerRow = {
  id: string;
  name: string;
  displayName: string;
  slug: string;
  stableName: string | null;
  location: string | null;
  status: TrainerStatus;
  photoUrl: string | null;
  /** ENG-766: admin opt-in to the public stablepass.co trainer strip. */
  marketingVisible: boolean;
  initials: string;
  contactEmail: string | null;
  horseCount: number;
  lastPostAt: string | null;
};

// The raw `trainer` columns this module selects. Typed explicitly (rather than
// the previous `Record<string, string>` cast) because `marketing_visible` is a
// boolean, and a string-shaped cast would silently mistype it.
type TrainerDbRow = {
  id: string;
  name: string;
  display_name: string | null;
  slug: string;
  stable_name: string | null;
  location: string | null;
  status: string | null;
  photo_url: string | null;
  marketing_visible: boolean | null;
};

// The single trainer row the EDIT page reads, and its mapping into the form's
// seed shape. Extracted from the page for the same reason listTrainers is: a
// Server Component cannot be unit-tested, and this mapping is load-bearing —
// if `marketing_photo_path` fails to seed, the form believes nothing is
// published, so un-publishing silently leaves a live object in a PUBLIC bucket.
export type TrainerDetailRow = {
  id: string;
  name: string;
  display_name: string | null;
  stable_name: string | null;
  location: string | null;
  bio: string | null;
  photo_url: string | null;
  status: string | null;
  marketing_visible: boolean | null;
  marketing_photo_path: string | null;
  /** ENG-746: the per-trainer public website link the member app renders. */
  website_url: string | null;
};

// The edit page reads its row with `select(TRAINER_DETAIL_COLUMNS)` and then
// CASTS the result to TrainerDetailRow. That cast is what makes this constant
// necessary (ENG-746): a cast cannot check a runtime projection, so dropping a
// column from a hand-written select string typechecks perfectly, and the field
// arrives `undefined`, coalesces to null, and the form silently blanks a saved
// value on the next save. A too-wide projection is just as quiet — PostgREST
// returns an error the caller swallows and the screen renders empty (see
// .rx/gotchas.md, ENG-766).
//
// Keying the map on `keyof TrainerDetailRow` makes the compiler the guard:
// adding a field to the type without adding it here fails `tsc`, and the select
// string is then derived rather than retyped.
export const TRAINER_DETAIL_COLUMN_MAP: Record<keyof TrainerDetailRow, true> = {
  id: true,
  name: true,
  display_name: true,
  stable_name: true,
  location: true,
  bio: true,
  photo_url: true,
  status: true,
  marketing_visible: true,
  marketing_photo_path: true,
  website_url: true,
};

// Spelled out as a literal rather than `Object.keys(...).join(",")` because
// supabase-js parses the select string as a TYPE: handing it a plain `string`
// collapses the result to `GenericStringError` and the row cast stops meaning
// anything. The literal and the map are kept in step by a test in data.test.ts,
// so the pair still fails loudly rather than drifting.
export const TRAINER_DETAIL_COLUMNS =
  "id,name,display_name,stable_name,location,bio,photo_url,status,marketing_visible,marketing_photo_path,website_url";

export type TrainerFormSeed = {
  id: string;
  name: string;
  displayName: string;
  stableName: string;
  location: string;
  bio: string;
  photoUrl: string | null;
  status: TrainerStatus;
  marketingVisible: boolean;
  marketingPhotoPath: string | null;
  websiteUrl: string | null;
};

export function toTrainerFormSeed(t: TrainerDetailRow): TrainerFormSeed {
  return {
    id: t.id,
    name: t.name,
    displayName: t.display_name ?? "",
    stableName: t.stable_name ?? "",
    location: t.location ?? "",
    bio: t.bio ?? "",
    photoUrl: t.photo_url ?? null,
    status: t.status === "onboarding" ? "onboarding" : "active",
    marketingVisible: t.marketing_visible === true,
    marketingPhotoPath: t.marketing_photo_path ?? null,
    // ENG-746. Seeds the Website field on edit. If this mapping is dropped the
    // form loads blank and the next save NULLs a website the admin never
    // touched, so it is asserted directly in data.test.ts.
    websiteUrl: t.website_url ?? null,
  };
}

/**
 * The `?sort=` values the Trainers table accepts (ENG-963), with the direction
 * a first click produces. `trainer`/`stable`/`status` order in Postgres; the
 * two DERIVED columns (`horses`, `lastpost`) are merged in JS from flat
 * per-trainer reads, so they are ordered here after the merge — which is exact,
 * not an approximation, because this list is unpaginated: `listTrainers`
 * already holds every row the filter matched, so sorting them in JS orders the
 * whole set, never one page of it.
 */
export const TRAINER_SORT_KEYS = ["trainer", "stable", "horses", "lastpost", "status"] as const;
export type TrainerSort = (typeof TRAINER_SORT_KEYS)[number];

export const TRAINER_SORT_DEFAULT_DIR: Record<TrainerSort, SortDir> = {
  trainer: "asc",
  stable: "asc",
  horses: "desc",
  lastpost: "desc",
  status: "asc",
};

/** Columns that Postgres can order directly, by DB column name. */
const TRAINER_DB_ORDER: Partial<Record<TrainerSort, string>> = {
  trainer: "name",
  stable: "stable_name",
  status: "status",
};

/** The value each sort key compares on, read off the merged row. */
const TRAINER_SORT_VALUE: Record<TrainerSort, (r: TrainerRow) => string | number | null> = {
  trainer: (r) => r.displayName,
  stable: (r) => r.stableName,
  horses: (r) => r.horseCount,
  // Compared as an epoch, not as an ISO string: the strings are only
  // lexicographically ordered while every one of them shares a format and a
  // zone, which is a property of today's data, not a guarantee.
  lastpost: (r) => (r.lastPostAt ? new Date(r.lastPostAt).getTime() : null),
  status: (r) => r.status,
};

export function sortTrainerRows(rows: TrainerRow[], sort: TrainerSort | "", dir: SortDir): TrainerRow[] {
  if (!sort) return rows;
  const value = TRAINER_SORT_VALUE[sort];
  // Copy before sorting: `listTrainers` hands its caller the array it built, and
  // an in-place sort of a shared array is a side effect waiting to surprise.
  // Ties break on display name so the order is total and stable across reloads.
  return [...rows].sort(
    (a, b) => compareValues(value(a), value(b), dir) || compareValues(a.displayName, b.displayName, "asc"),
  );
}

export type TrainerListParams = {
  status?: string | null;
  q?: string | null;
  sort?: TrainerSort | "";
  dir?: SortDir;
};

export type TrainerList = {
  rows: TrainerRow[];
  counts: { all: number; active: number; onboarding: number };
};

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function timeAgo(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "-";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "-";
  const mins = Math.floor((now.getTime() - then) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(iso).toLocaleDateString();
}

// PostgREST `.or()` grammar treats `,()` as structural; strip them from free
// text so a search term can never produce a malformed filter (mirrors posts).
function sanitize(q: string): string {
  return q.replace(/[(),]/g, " ").trim();
}

export async function listTrainers(
  sb: SupabaseClient,
  params: TrainerListParams = {},
): Promise<TrainerList> {
  const status = params.status === "active" || params.status === "onboarding" ? params.status : null;
  const text = params.q ? sanitize(params.q) : "";
  const sort = params.sort ?? "";
  const dir: SortDir = params.dir ?? (sort ? TRAINER_SORT_DEFAULT_DIR[sort] : "asc");

  // Direct columns are ordered by Postgres; the derived ones fall back to the
  // name order here and are re-sorted after the merge below. `name` stays the
  // trailing tiebreaker either way, so equal-valued rows keep a stable order.
  const dbOrder = sort ? TRAINER_DB_ORDER[sort] : undefined;
  let query = sb
    .from("trainer")
    .select("id,name,display_name,slug,stable_name,location,status,photo_url,marketing_visible")
    .order(dbOrder ?? "name", { ascending: dbOrder ? dir === "asc" : true });
  if (dbOrder && dbOrder !== "name") query = query.order("name", { ascending: true });
  if (status) query = query.eq("status", status);
  if (text) {
    const like = `%${text}%`;
    query = query.or(
      `name.ilike.${like},display_name.ilike.${like},stable_name.ilike.${like},location.ilike.${like}`,
    );
  }

  // Roster counts for the filter chips are unfiltered (they show the whole set).
  const [{ data: trainers }, { data: statuses }, { data: horses }, { data: posts }, { data: contacts }] =
    await Promise.all([
      query,
      sb.from("trainer").select("status"),
      sb.from("horse").select("trainer_id"),
      sb.from("post").select("source_trainer_id,published_at,created_at"),
      sb.from("trainer_contact").select("trainer_id,role,email"),
    ]);

  const horseCounts = new Map<string, number>();
  for (const h of (horses ?? []) as { trainer_id: string }[])
    horseCounts.set(h.trainer_id, (horseCounts.get(h.trainer_id) ?? 0) + 1);

  const lastPost = new Map<string, string>();
  for (const p of (posts ?? []) as { source_trainer_id: string; published_at: string | null; created_at: string }[]) {
    if (!p.source_trainer_id) continue;
    const at = p.published_at ?? p.created_at;
    const cur = lastPost.get(p.source_trainer_id);
    if (!cur || new Date(at) > new Date(cur)) lastPost.set(p.source_trainer_id, at);
  }

  const emails = new Map<string, string>();
  for (const c of (contacts ?? []) as { trainer_id: string; role: string | null; email: string | null }[]) {
    if (!c.email) continue;
    const isTrainerRole = (c.role ?? "").toLowerCase().includes("trainer");
    if (isTrainerRole || !emails.has(c.trainer_id)) emails.set(c.trainer_id, c.email);
  }

  const rows: TrainerRow[] = ((trainers ?? []) as TrainerDbRow[]).map((t) => ({
    id: t.id,
    name: t.name,
    displayName: t.display_name ?? t.name,
    slug: t.slug,
    stableName: t.stable_name ?? null,
    location: t.location ?? null,
    status: (t.status as TrainerStatus) ?? "active",
    photoUrl: t.photo_url ?? null,
    // Coerced, not passed through: the list badge must reflect the flag exactly,
    // and a missing column would otherwise render as a falsy-but-undefined badge.
    marketingVisible: t.marketing_visible === true,
    initials: initials(t.name),
    contactEmail: emails.get(t.id) ?? null,
    horseCount: horseCounts.get(t.id) ?? 0,
    lastPostAt: lastPost.get(t.id) ?? null,
  }));

  const all = (statuses ?? []) as { status: string }[];
  const counts = {
    all: all.length,
    active: all.filter((s) => s.status === "active").length,
    onboarding: all.filter((s) => s.status === "onboarding").length,
  };

  // `sortTrainerRows` is the authority for the rendered order, for every sort
  // key — the derived columns (`horses`, `lastpost`) BECAUSE Postgres never saw
  // them, and the direct ones because the table renders `displayName`
  // (`display_name ?? name`) while Postgres ordered the raw `name`. Two rows
  // whose display names and real names disagree would otherwise appear out of
  // alphabetical order in a list that claims to be sorted by trainer.
  return { rows: sortTrainerRows(rows, sort, dir), counts };
}

// The two counts that can refuse a trainer delete: `horse.trainer_id` and
// `post.source_trainer_id` are BOTH not-null with no ON DELETE, so a trainer is
// the last thing that can go. `head: true` fetches no rows — these are count
// queries only, and they run in parallel.
//
// Throws on error rather than returning 0: reporting "nothing references this
// trainer" because the count failed would offer a delete Postgres is certain to
// reject, which is exactly the opaque 23503 this screen exists to prevent.
export async function countTrainerReferences(
  sb: SupabaseClient,
  trainerId: string,
): Promise<{ posts: number; horses: number }> {
  const [postRes, horseRes] = await Promise.all([
    sb.from("post").select("id", { count: "exact", head: true }).eq("source_trainer_id", trainerId),
    sb.from("horse").select("id", { count: "exact", head: true }).eq("trainer_id", trainerId),
  ]);
  if (postRes.error || horseRes.error)
    throw new Error(
      `trainer reference count failed (${postRes.error?.code ?? horseRes.error?.code ?? "unknown"})`,
    );
  return { posts: postRes.count ?? 0, horses: horseRes.count ?? 0 };
}

/**
 * Where the Trainers list's "N horses" cell links (Justin, 2 Sep 2026: "click
 * on the horses to see which horses the trainer has"). Null for a trainer with
 * no horses — an empty scoped list is a dead end, so the count stays plain.
 */
export function trainerHorsesHref(trainerId: string, horseCount: number): string | null {
  if (horseCount <= 0) return null;
  return `/horses?trainerId=${encodeURIComponent(trainerId)}`;
}

/**
 * The posts half of the two-way jump (ENG-963): the Trainers list's "Last post"
 * cell opens that trainer's posts, exactly as the horse count opens their
 * horses, and each scoped list links across to the other.
 *
 * Null for a trainer who has never posted — same reasoning as the horse count:
 * an empty scoped list is a dead end, so the cell stays plain text.
 */
export function trainerPostsHref(trainerId: string, lastPostAt: string | null): string | null {
  if (!lastPostAt) return null;
  return `/posts?trainerId=${encodeURIComponent(trainerId)}`;
}
