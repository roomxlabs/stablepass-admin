// The Posts library's sort model — SHARED by the Server Component list
// (`app/(dash)/posts/page.tsx`) and the BFF list (`GET /api/admin/posts`).
//
// It lives in lib/ precisely because it has two callers: if the screen and the
// endpoint each owned their own mapping they would drift, and `?sort=` would
// mean one thing in the UI and another to anything reading the API.
//
// The sort is applied SERVER-SIDE, as `.order()` on the query, and never as a
// client-side sort of the fetched page. Posts are offset-paginated: sorting one
// 20-row page in the browser would reorder that page only, so "oldest first"
// would show the newest 20 posts rearranged — the wrong 20 rows, confidently.

export type SortDir = "asc" | "desc";

/** The `?sort=` values the Posts list accepts. "" = the default order. */
export const POST_SORT_KEYS = ["published", "engagement", "status", "horse"] as const;
export type PostSort = (typeof POST_SORT_KEYS)[number];

/**
 * First-click direction per column. Dates and counts open newest/biggest-first
 * (what an operator scanning a library actually wants); the alphabetical and
 * status columns open A→Z.
 */
export const POST_SORT_DEFAULT_DIR: Record<PostSort, SortDir> = {
  published: "desc",
  engagement: "desc",
  status: "asc",
  horse: "asc",
};

/** Coerce a raw `?sort=` param; anything unrecognised means "default order". */
export function parsePostSort(v: unknown): PostSort | "" {
  return typeof v === "string" && (POST_SORT_KEYS as readonly string[]).includes(v)
    ? (v as PostSort)
    : "";
}

/** One `.order(column, options)` call. */
export type OrderSpec = {
  column: string;
  ascending: boolean;
  /** Only set where NULLs are possible; omitted otherwise. */
  nullsFirst?: boolean;
};

// Which DB column each sort key orders by.
//
// `horse` orders by the EMBEDDED horse name using PostgREST's
// `embedded(column)` order syntax — the embed is aliased `horse:horse_id(...)`
// in both callers' select strings, and `post.horse_id` is NOT NULL, so every
// row participates. It is deliberately not `horse_id`: sorting by a uuid is
// sorting by nothing an operator can see.
const ORDER_COLUMN: Record<PostSort, string> = {
  published: "published_at",
  engagement: "like_count",
  status: "status",
  horse: "horse(display_name)",
};

// Columns that can be NULL, so the order has to say where the NULLs go.
// `published_at` is null for drafts; `like_count` is null before any
// engagement. In BOTH directions they sink: a draft is not "the oldest post",
// and floating twenty of them to the top of an ascending sort hides the rows
// the operator asked to see.
// `horse` is included because `HorseEmbed.display_name` is typed `string | null`
// (app/(dash)/posts/types.ts). Leaving it out was justified by `post.horse_id`
// being NOT NULL, but that is FK nullability, not COLUMN nullability — a horse
// with no display_name would float to the top of a descending sort, which is
// the exact behaviour the two entries below exist to prevent.
const NULLABLE: Partial<Record<PostSort, true>> = {
  published: true,
  engagement: true,
  horse: true,
};

/**
 * The posts select string, adjusted for the active sort.
 *
 * Ordering the PARENT rows by an embedded column requires the embed to be an
 * INNER join — `supabase-js` says so in its own `.order()` docs ("you can order
 * referenced tables, but it only affects the ordering of the parent table if
 * you use `!inner`"), and without it PostgREST is free to order nothing at all.
 * So the `horse` embed becomes `!inner` for exactly the one sort that needs it.
 *
 * No rows are lost by the inner join: `post.horse_id` is NOT NULL (every post
 * type, `text` included, requires a horse — see the create route), so every row
 * has a horse to join to.
 *
 * Every other sort gets the select string UNCHANGED, byte for byte, so the
 * default query is exactly the one that shipped before this ticket.
 */
// The two REAL select strings, hoisted here from their callers so that
// `postsSelect`'s rewrite can be tested against what actually ships rather than
// against a hand-written literal in the test file. A test that builds its own
// select string proves the helper and nothing about the wiring.
//
// The Posts SCREEN needs the media columns (thumbnails, poster, playback); the
// BFF list does not. Both carry the `horse:horse_id(...)` embed the horse sort
// rewrites, and both are asserted in lib/posts/sort.test.ts.
export const POSTS_PAGE_SELECT =
  "id,horse_id,type,status,title,body,media_url,mux_playback_id,poster_url,poster_time_s,like_count,published_at,scheduled_for,created_at," +
  "horse:horse_id(display_name,racing_name,photo_url),trainer:source_trainer_id(name)";

// `label` (ENG-745) is selected so the posts library can render the category
// chip; that rendering is a later slice, this only carries it.
export const POSTS_API_SELECT =
  "id,horse_id,type,status,title,body,label,like_count,published_at,scheduled_for,created_at," +
  "horse:horse_id(display_name,racing_name),trainer:source_trainer_id(name)";

export const HORSE_EMBED = "horse:horse_id(";
export const HORSE_EMBED_INNER = "horse:horse_id!inner(";

export function postsSelect(select: string, sort: PostSort | ""): string {
  if (sort !== "horse") return select;
  // THROW rather than return the input unchanged. `String.replace` with a
  // needle that does not match returns the original string silently, so a
  // reformatted select ("horse:horse_id (" , a newline, a renamed alias) would
  // degrade this sort to "orders nothing" while every test stayed green — the
  // failure is invisible precisely because the query remains valid.
  if (!select.includes(HORSE_EMBED))
    throw new Error(
      `postsSelect: no \`${HORSE_EMBED}\` embed in the select string, so the horse sort cannot be ordered. ` +
        "Update HORSE_EMBED if the alias changed.",
    );
  return select.replace(HORSE_EMBED, HORSE_EMBED_INNER);
}

/**
 * The ordered list of `.order()` calls for a `?sort=`/`?dir=` pair.
 *
 * ALWAYS ends with `created_at desc` as a tiebreaker. Without it, rows sharing
 * a sort value (every draft has a null `published_at`, most posts have the same
 * `status`) come back in whatever order Postgres finds convenient — which is
 * free to differ between two pages of the SAME offset-paginated query, so a row
 * can appear on both page 1 and page 2, or on neither.
 */
export function postsOrder(sort: PostSort | "", dir: SortDir): OrderSpec[] {
  // `created_at` is stable but NOT unique — seeded/imported/bulk-created rows
  // share a timestamp — so the PK is the final key. Without it the docstring
  // above ("a row can appear on both page 1 and page 2, or on neither") is
  // still technically true for equal timestamps.
  const tiebreak: OrderSpec[] = [
    { column: "created_at", ascending: false },
    { column: "id", ascending: false },
  ];
  if (!sort) return tiebreak;

  const primary: OrderSpec = {
    column: ORDER_COLUMN[sort],
    ascending: dir === "asc",
    ...(NULLABLE[sort] ? { nullsFirst: false } : {}),
  };
  return [primary, ...tiebreak];
}
