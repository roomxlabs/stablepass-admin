import type { SupabaseClient } from "@supabase/supabase-js";

// Server-side data access for the admin Trainers list. Kept out of the page
// component so it can be unit-tested against the Supabase fake.
//
// This used to be FIVE full-table reads merged in JS — every trainer, every
// horse, every trainer_contact and, worst, EVERY POST IN THE DATABASE (all of
// `post`, just to find one timestamp per trainer). It is now one trainer read
// that derives all three per-trainer facts with PostgREST embedding: aggregate
// counts (`horse(count)`, `post(count)`), the newest post via an embedded
// ordered `post(...)` limited to 1 per trainer, and the contacts inline. The
// roster counts behind the filter chips are three `head: true` counts, which
// fetch no rows at all.
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

export type TrainerListParams = { status?: string | null; q?: string | null };

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

/**
 * The trainer-list projection.
 *
 * Everything the row needs comes back in ONE request:
 *  - `horseCount` from the `horse(count)` aggregate — no horse rows travel;
 *  - `lastPostAt` from `last_post`, an embed of the SAME `post` relation under
 *    a second alias, ordered and `.limit(1, { referencedTable })`-ed so exactly
 *    one row per trainer comes back instead of the whole table;
 *  - `contactEmail` from the inline `trainer_contact` rows (a handful each).
 *
 * The `!trainer_id` / `!source_trainer_id` hints name the FK explicitly. They
 * are not decoration: `post` and `horse` each reach `trainer` by one column
 * today, but an added FK would make a bare `post(count)` ambiguous and
 * PostgREST answers ambiguity with a 400 that this module surfaces as an empty
 * list. Aliasing `post` twice is what lets one query carry both the count and
 * the newest row.
 */
export const TRAINER_LIST_SELECT =
  "id,name,display_name,slug,stable_name,location,status,photo_url,marketing_visible," +
  "horses:horse!trainer_id(count),posts:post!source_trainer_id(count)," +
  "last_post:post!source_trainer_id(published_at,created_at)," +
  "contacts:trainer_contact(trainer_id,role,email)";

/** A PostgREST `rel(count)` aggregate: a one-element array carrying the count. */
type CountEmbed = { count: number }[] | null;
type LastPostEmbed = { published_at: string | null; created_at: string }[] | null;
type ContactEmbed = { trainer_id?: string; role: string | null; email: string | null }[] | null;

type TrainerListDbRow = TrainerDbRow & {
  horses: CountEmbed;
  posts: CountEmbed;
  last_post: LastPostEmbed;
  contacts: ContactEmbed;
};

function embedCount(e: CountEmbed): number {
  return e?.[0]?.count ?? 0;
}

/**
 * The one contact whose email the list shows. Unchanged rule: a contact whose
 * role mentions "trainer" wins, otherwise the first one with an email.
 */
function contactEmail(contacts: ContactEmbed): string | null {
  let fallback: string | null = null;
  for (const c of contacts ?? []) {
    if (!c.email) continue;
    if ((c.role ?? "").toLowerCase().includes("trainer")) return c.email;
    if (fallback === null) fallback = c.email;
  }
  return fallback;
}

export async function listTrainers(
  sb: SupabaseClient,
  params: TrainerListParams = {},
): Promise<TrainerList> {
  const status = params.status === "active" || params.status === "onboarding" ? params.status : null;
  const text = params.q ? sanitize(params.q) : "";

  let query = sb
    .from("trainer")
    .select(TRAINER_LIST_SELECT)
    .order("name", { ascending: true })
    // Newest post FIRST inside the embed, then take one. `nullsFirst: false`
    // matters: a draft has a null `published_at`, and without it Postgres sorts
    // nulls first on a DESC order, so the single row we keep would be a draft
    // for any trainer who has one — i.e. the column would report the newest
    // DRAFT rather than the newest published post.
    .order("published_at", { referencedTable: "last_post", ascending: false, nullsFirst: false })
    .limit(1, { referencedTable: "last_post" });
  if (status) query = query.eq("status", status);
  if (text) {
    const like = `%${text}%`;
    query = query.or(
      `name.ilike.${like},display_name.ilike.${like},stable_name.ilike.${like},location.ilike.${like}`,
    );
  }

  // Roster counts for the filter chips are unfiltered (they show the whole set)
  // and are `head: true`, so they fetch NO rows — the previous
  // `select("status")` pulled one row per trainer purely to run `.filter()` on
  // it in JS.
  const [{ data: trainers }, allRes, activeRes, onboardingRes] = await Promise.all([
    query,
    sb.from("trainer").select("id", { count: "exact", head: true }),
    sb.from("trainer").select("id", { count: "exact", head: true }).eq("status", "active"),
    sb.from("trainer").select("id", { count: "exact", head: true }).eq("status", "onboarding"),
  ]);

  const rows: TrainerRow[] = ((trainers ?? []) as unknown as TrainerListDbRow[]).map((t) => {
    const last = t.last_post?.[0] ?? null;
    return {
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
      contactEmail: contactEmail(t.contacts),
      horseCount: embedCount(t.horses),
      // Same coalesce as before (a post with no `published_at` falls back to
      // `created_at`), now applied to the ONE row the embed returned.
      lastPostAt: last ? last.published_at ?? last.created_at : null,
    };
  });

  const counts = {
    all: allRes.count ?? 0,
    active: activeRes.count ?? 0,
    onboarding: onboardingRes.count ?? 0,
  };

  return { rows, counts };
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
