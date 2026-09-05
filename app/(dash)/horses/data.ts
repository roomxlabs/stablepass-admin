import type { SupabaseClient } from "@supabase/supabase-js";

// Server-side read for the Horses DB list screen. A resource LIST screen has no
// BFF endpoint here — the Server Component reads through the caller's RLS admin
// client — so the query lives in this small injectable helper to keep it
// unit-testable against a scriptable fake.

export type CountEmbed = { count: number }[];

/**
 * The Horses grid's `?sort=` values (ENG-963). A card grid has no column
 * headers to click, so this is driven by a `<select>` — but it rides the same
 * URL rails as the filters, so a sorted view is still shareable.
 *
 * "" (absent) keeps the historical default, `created_at desc` (= "newest").
 */
export const HORSE_SORT_KEYS = ["name", "newest", "followers", "lastpost"] as const;
export type HorseSort = (typeof HORSE_SORT_KEYS)[number];

/** Columns Postgres can order directly; `[column, ascending]`. */
const HORSE_DB_ORDER: Partial<Record<HorseSort, [string, boolean]>> = {
  name: ["display_name", true],
  newest: ["created_at", false],
};

export type HorseRow = {
  id: string;
  display_name: string;
  racing_name: string | null;
  stable_name: string | null;
  sex: string | null;
  is_gelded: boolean | null;
  // Computed in Postgres (ENG-615), not stored and not computed here.
  horse_age: number | null;
  horse_description: string | null;
  colour: string | null;
  foaling_year: number | null;
  status: string | null;
  training_status: string | null;
  photo_url: string | null;
  trainer: { display_name: string | null } | { display_name: string | null }[] | null;
  follows: CountEmbed | null;
  posts: CountEmbed | null;
};

// The horses-list projection.
//
// `horse_age` and `horse_description` are PostgREST COMPUTED COLUMNS, so they
// are NOT returned by `select("*")` and MUST be named explicitly — dropping
// either one makes the list silently lose the age or the description rather
// than failing to compile. `tsc` cannot see a too-narrow `.select()`, so this
// string is asserted directly in `__tests__/data.test.ts`.
//
// `follows:follow(count)` is also the discriminator e2e/mock-supabase.mjs keys
// the horses-list branch on — keep it.
export const HORSE_LIST_SELECT =
  "id, display_name, racing_name, stable_name, sex, is_gelded, horse_age, horse_description, colour, foaling_year, status, training_status, photo_url, created_at, trainer:trainer_id(display_name), follows:follow(count), posts:post(count)";

// Throw rather than degrade. A table read that swallows `error` renders an RLS
// regression as a legitimately-empty list ("No horses yet"), which is precisely
// the failure the admin gate exists to prevent. The message carries no Postgres
// text onward to the client — Next serves a generic error digest.
function unwrap<T>(res: { data: T | null; error: { code?: string } | null }, what: string): T | null {
  if (res.error) throw new Error(`${what} read failed (${res.error.code ?? "unknown"})`);
  return res.data;
}

// `trainerId` (Justin, 2 Sep 2026: "click on the horses to see which horses
// the trainer has") scopes the list EXACTLY to one trainer — unlike `q`, which
// matches trainer names loosely. The two compose: a search within a trainer's
// horses is still a search.
export async function fetchHorses(
  sb: SupabaseClient,
  q: string,
  trainerId: string | null = null,
  sort: HorseSort | "" = "",
): Promise<HorseRow[]> {
  // `name` and `newest` are real columns, so Postgres orders them. `followers`
  // is a PostgREST embedded COUNT and `lastpost` is not on this table at all —
  // neither is orderable here, so both keep the default order and are sorted by
  // the page after the counts are read. That is exact rather than a
  // one-page approximation because this list is UNPAGINATED (hotfix, 25 Aug
  // 2026): `fetchHorses` returns every row the operator can read, so ordering
  // them in JS orders the whole set.
  const [orderColumn, orderAsc] = HORSE_DB_ORDER[sort || "newest"] ?? ["created_at", false];
  let query = sb
    .from("horse")
    .select(HORSE_LIST_SELECT)
    .order(orderColumn, { ascending: orderAsc });

  if (trainerId) query = query.eq("trainer_id", trainerId);

  if (q) {
    const trainerRes = await sb.from("trainer").select("id").ilike("display_name", `%${q}%`);
    const trainerIds = ((unwrap(trainerRes, "trainer") ?? []) as { id: string }[]).map((t) => t.id);
    // Strip PostgREST logical-tree separators so a comma/paren in `q` cannot
    // splice extra OR terms. (`.ilike()` above is parameterized and safe.)
    const safeQ = q.replace(/[,()]/g, " ");
    const ors = [
      `display_name.ilike.%${safeQ}%`,
      `racing_name.ilike.%${safeQ}%`,
      `stable_name.ilike.%${safeQ}%`,
    ];
    if (trainerIds.length) ors.push(`trainer_id.in.(${trainerIds.join(",")})`);
    query = query.or(ors.join(","));
  }

  return (unwrap(await query, "horse") ?? []) as HorseRow[];
}

/**
 * Most-recent post per HORSE, for the grid's "last post" sort (ENG-963).
 *
 * One flat read of the whole `post` table, merged in JS — the same shape the
 * Trainers list already uses for its own last-post column, and for the same
 * reason: PostgREST cannot return a per-parent MAX through an embed. It is
 * called ONLY when that sort is active, so the default grid load still makes
 * exactly the round-trips it made before this ticket.
 *
 * `published_at ?? created_at`: a scheduled or draft post has no published_at,
 * and a horse whose only activity is a draft has still been touched more
 * recently than one with nothing at all.
 */
export async function fetchHorseLastPostMap(sb: SupabaseClient): Promise<Map<string, string>> {
  const res = await sb.from("post").select("horse_id,published_at,created_at");
  const rows = (unwrap(res, "post") ?? []) as {
    horse_id: string;
    published_at: string | null;
    created_at: string;
  }[];
  const last = new Map<string, string>();
  for (const r of rows) {
    if (!r.horse_id) continue;
    const at = r.published_at ?? r.created_at;
    const cur = last.get(r.horse_id);
    if (!cur || new Date(at) > new Date(cur)) last.set(r.horse_id, at);
  }
  return last;
}

/**
 * The display name behind a `?trainerId=` filter, for the "Showing horses for
 * …" chip. Null when the id matches nothing (a stale link) — the page then
 * still filters, and the chip names the id's absence honestly.
 */
export async function fetchTrainerLabel(sb: SupabaseClient, trainerId: string): Promise<string | null> {
  const res = await sb.from("trainer").select("display_name").eq("id", trainerId).maybeSingle();
  const row = unwrap(res, "trainer") as { display_name: string | null } | null;
  return row?.display_name ?? null;
}

export type TrainerOption = {
  id: string;
  display_name: string | null;
  stable_name: string | null;
  /** ENG-829 — gates the horse Shares for-sale toggle. */
  website_url: string | null;
};

// The Add/Edit form's trainer dropdown. Same rule as the list: a failed read
// must not render as "no trainers exist", which would quietly invite the
// operator to create a duplicate trainer. website_url is required so the form
// can gate shares_for_sale without a second round-trip.
export async function fetchTrainerOptions(sb: SupabaseClient): Promise<TrainerOption[]> {
  const res = await sb
    .from("trainer")
    .select("id, display_name, stable_name, website_url")
    .order("display_name", { ascending: true });
  return (unwrap(res, "trainer") ?? []) as TrainerOption[];
}

// The columns the edit form prefills from. Previously this row was implicitly
// `any` (a bare `select("*")`), so a renamed column failed silently at runtime.
export type HorseEditRow = {
  trainer_id: string | null;
  stable_name: string | null;
  display_name: string | null;
  racing_name: string | null;
  foaling_year: number | null;
  sex: string | null;
  is_gelded: boolean | null;
  colour: string | null;
  sire: string | null;
  dam: string | null;
  starts: number | null;
  wins: number | null;
  places: number | null;
  prize_money_cents: number | null;
  story: string | null;
  photo_url: string | null;
  status: string | null;
  training_status: string | null;
  /** ENG-829 */
  shares_for_sale: boolean | null;
};

// One horse for the edit form. Returns null ONLY for a genuine not-found; a
// query error throws, so an RLS regression cannot present itself as a 404.
export async function fetchHorseForEdit(sb: SupabaseClient, id: string): Promise<HorseEditRow | null> {
  const res = await sb.from("horse").select("*").eq("id", id).maybeSingle();
  return (unwrap(res, "horse") ?? null) as HorseEditRow | null;
}

// How many posts point at this horse — the ONE thing that can refuse its
// delete (`post.horse_id` is not-null with no ON DELETE). `head: true` fetches
// no rows, so this is a count query and nothing more.
//
// Throws on error like every other read here, deliberately: a swallowed error
// would return 0 and present a delete that Postgres is certain to reject as
// one that is safe to offer.
export async function countPostsForHorse(sb: SupabaseClient, horseId: string): Promise<number> {
  const { count, error } = await sb
    .from("post")
    .select("id", { count: "exact", head: true })
    .eq("horse_id", horseId);
  if (error) throw new Error(`post count read failed (${error.code ?? "unknown"})`);
  return count ?? 0;
}
