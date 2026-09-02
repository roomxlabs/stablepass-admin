import type { SupabaseClient } from "@supabase/supabase-js";

// Server-side read for the Horses DB list screen. A resource LIST screen has no
// BFF endpoint here — the Server Component reads through the caller's RLS admin
// client — so the query lives in this small injectable helper to keep it
// unit-testable against a scriptable fake.

export type CountEmbed = { count: number }[];

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

/** The status chips above the Horses list. */
export type HorseFilter = "all" | "active" | "racing" | "retired";

/**
 * The chip's predicate, expressed as PostgREST rather than as a JS `.filter()`.
 *
 * "Active" is the one that needs care. In JS it was `training_status !==
 * "retired"`, which INCLUDES a null. A bare `.neq("training_status","retired")`
 * does not: SQL's `NULL <> 'retired'` is NULL, so every horse whose training
 * status was never set would silently vanish from the default-ish chip. The
 * `.or()` restores them explicitly. PostgREST ANDs multiple `or=` params, so
 * this composes safely with the search's own `or`.
 */
function applyFilter<T extends { eq: (c: string, v: unknown) => T; or: (e: string) => T }>(
  query: T,
  filter: HorseFilter,
): T {
  if (filter === "racing") return query.eq("training_status", "racing");
  if (filter === "retired") return query.eq("training_status", "retired");
  if (filter === "active") return query.or("training_status.is.null,training_status.neq.retired");
  return query;
}

/**
 * `trainerId` (Justin, 2 Sep 2026: "click on the horses to see which horses
 * the trainer has") scopes the list EXACTLY to one trainer — unlike `q`, which
 * matches trainer names loosely. The two compose: a search within a trainer's
 * horses is still a search.
 *
 * `filter` and `limit` are new, and both used to happen in JS AFTER the whole
 * table had already crossed the wire with two embedded count aggregates per
 * row. They are PostgREST now.
 *
 * NOTE ON `limit`: this is a BOUND, not pagination. The 25 Aug 2026 hotfix
 * removed paging from this screen at Justin's request — every horse renders on
 * one scrollable page — and that decision stands. What changed is only that the
 * query is no longer unbounded; the default is far above any real stable's
 * roster, so the screen behaves identically while a runaway table can no longer
 * take the page down.
 */
export const HORSE_LIST_LIMIT = 1000;

export async function fetchHorses(
  sb: SupabaseClient,
  q: string,
  trainerId: string | null = null,
  opts: { filter?: HorseFilter; limit?: number; trainerIds?: string[] } = {},
): Promise<HorseRow[]> {
  const limit = opts.limit ?? HORSE_LIST_LIMIT;
  let query = sb
    .from("horse")
    .select(HORSE_LIST_SELECT)
    .order("created_at", { ascending: false })
    .range(0, limit - 1);

  if (trainerId) query = query.eq("trainer_id", trainerId);
  query = applyFilter(query, opts.filter ?? "all");

  if (q) {
    // The caller may already have resolved these (the page shares one lookup
    // between the list and the four chip counts); otherwise do it here, which
    // keeps `fetchHorses(sb, q)` working on its own.
    const trainerIds = opts.trainerIds ?? (await searchTrainerIds(sb, q));
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
 * The four chip counts, as four `{ count: "exact", head: true }` reads that
 * fetch NO rows. They previously came from `.filter().length` over the full
 * list — which is why the list had to be full in the first place.
 *
 * They carry the same `trainerId` scope and the same search as the list, so a
 * chip never advertises horses the current view could not show. `q` needs the
 * trainer-name lookup the list does, so it is resolved once and passed in.
 */
export async function countHorsesByFilter(
  sb: SupabaseClient,
  q: string,
  trainerId: string | null,
  trainerIds: string[],
): Promise<Record<HorseFilter, number>> {
  const base = () => {
    let query = sb.from("horse").select("id", { count: "exact", head: true });
    if (trainerId) query = query.eq("trainer_id", trainerId);
    if (q) {
      const safeQ = q.replace(/[,()]/g, " ");
      const ors = [
        `display_name.ilike.%${safeQ}%`,
        `racing_name.ilike.%${safeQ}%`,
        `stable_name.ilike.%${safeQ}%`,
      ];
      if (trainerIds.length) ors.push(`trainer_id.in.(${trainerIds.join(",")})`);
      query = query.or(ors.join(","));
    }
    return query;
  };

  const keys: HorseFilter[] = ["all", "active", "racing", "retired"];
  const results = await Promise.all(
    keys.map(async (k) => {
      const res = await applyFilter(base(), k);
      if (res.error) throw new Error(`horse count read failed (${res.error.code ?? "unknown"})`);
      return res.count ?? 0;
    }),
  );
  return { all: results[0], active: results[1], racing: results[2], retired: results[3] };
}

/**
 * The trainer ids a free-text search matches, for the count queries above.
 * Same read the list does; hoisted so both share ONE lookup per request.
 */
export async function searchTrainerIds(sb: SupabaseClient, q: string): Promise<string[]> {
  if (!q) return [];
  const res = await sb.from("trainer").select("id").ilike("display_name", `%${q}%`);
  return ((unwrap(res, "trainer") ?? []) as { id: string }[]).map((t) => t.id);
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
