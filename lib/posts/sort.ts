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
export const POST_SORT_KEYS = ["published", "engagement", "status", "subject"] as const;
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
  subject: "asc",
};

/** Pre-ENG-1293 `?sort=` values, kept parsing so bookmarked URLs keep meaning
 * what they meant. `horse` was renamed `subject` when the sort stopped being
 * horse-only; mapping it (rather than dropping it to the default order) is
 * what makes an old bookmark show the sort the operator actually saved.
 *
 * A `Map`, deliberately, NOT an object literal: this is looked up with a
 * user-controlled string, and `key in {…}` / `{…}[key]` walk the prototype
 * chain, so `?sort=constructor` (or `toString`, `valueOf`, `__proto__`) would
 * come back as a `Function` typed `PostSort`. `tsc` cannot see that — indexing
 * a `Record<string, PostSort>` is typed `PostSort` whatever comes out — and the
 * bogus value then reaches `ORDER_COLUMN[sort]` as `undefined`, which PostgREST
 * 400s on. The allow-list this alias table sits behind exists precisely so no
 * input can escape it; a `Map` keeps that true. */
const LEGACY_SORT_ALIASES = new Map<string, PostSort>([["horse", "subject"]]);

/** Coerce a raw `?sort=` param; anything unrecognised means "default order". */
export function parsePostSort(v: unknown): PostSort | "" {
  if (typeof v !== "string") return "";
  if ((POST_SORT_KEYS as readonly string[]).includes(v)) return v as PostSort;
  return LEGACY_SORT_ALIASES.get(v) ?? "";
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
// `subject` orders by the `subject_name` PostgREST computed column on `post`
// (added by ENG-1292) — a post-level column, so it needs no embed and no
// join, which is what makes the sort cover horse, trainer AND StablePass
// posts. Note that the BE's horse arm is display-first with both sides
// trimmed (`coalesce(nullif(btrim(display_name),''), nullif(btrim(racing_name),''))`)
// so the list sorts by exactly the string `app/(dash)/posts/format.ts` renders
// in the cell.
const ORDER_COLUMN: Record<PostSort, string> = {
  published: "published_at",
  engagement: "like_count",
  status: "status",
  subject: "subject_name",
};

// Columns that can be NULL, so the order has to say where the NULLs go.
// `published_at` is null for drafts; `like_count` is null before any
// engagement. In BOTH directions they sink: a draft is not "the oldest post",
// and floating twenty of them to the top of an ascending sort hides the rows
// the operator asked to see.
// `subject_name` is NULL when the name cannot be resolved (horse row hidden,
// missing or unreadable), and those must sink too, for the same reason: a
// post with no resolvable name is not "the first post alphabetically", and
// floating it to the top of a descending sort hides the rows the operator
// asked to see.
const NULLABLE: Partial<Record<PostSort, true>> = {
  published: true,
  engagement: true,
  subject: true,
};

// The two REAL select strings, hoisted here from their callers so a test can
// pin what actually ships rather than a hand-written literal in the test
// file. A test that builds its own select string proves nothing about the
// wiring.
//
// The Posts SCREEN needs the media columns (thumbnails, poster, playback); the
// BFF list does not. Both are asserted in lib/posts/sort.test.ts.
// `label` is LOAD-BEARING for the screen (ENG-979 / #86): `mapPostRow` names
// every row by its label, so dropping it from this string makes every label
// vanish from the list with a GREEN suite — format.test.ts tests the mapper,
// not the select. lib/posts/sort.test.ts pins it here for that reason.
// `subject` + `byline` are LOAD-BEARING the same way `label` is (ENG-1269):
// `mapPostRow` names every row through `subjectLabel(...)`, so dropping either
// from this string silently relabels every trainer/StablePass row as a horse
// post with a GREEN suite — format.test.ts tests the mapper, not the select.
// lib/posts/sort.test.ts pins them here for that reason.
// `subject_name` (ENG-1292/ENG-1293) is the computed column the "Posted as"
// sort orders by; it is fetched so the order target is part of the
// projection, not merely a column Postgres can order without returning.
export const POSTS_PAGE_SELECT =
  "id,subject,subject_name,horse_id,byline,type,status,title,label,body,media_url,mux_playback_id,poster_url,poster_time_s,like_count,published_at,scheduled_for,created_at," +
  "horse:horse_id(display_name,racing_name,photo_url),trainer:source_trainer_id(name)";

// `label` (ENG-745) is selected so the posts library can render the category
// chip; that rendering is a later slice, this only carries it.
export const POSTS_API_SELECT =
  "id,subject,subject_name,horse_id,byline,type,status,title,body,label,like_count,published_at,scheduled_for,created_at," +
  "horse:horse_id(display_name,racing_name),trainer:source_trainer_id(name)";

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
