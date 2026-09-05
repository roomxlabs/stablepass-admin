// One href builder for the URL-driven admin lists (posts / horses / trainers).
//
// Every list screen already carried its own near-identical `buildXHref`
// (posts/format.ts, horses/page.tsx, trainers/page.tsx). Sort rides the same
// rails — `?sort=&dir=` are just two more params — so hoisting the builder here
// is what keeps "sort survives a refresh, a share and a filter change" true on
// all three without three copies of the same drop-empty logic.
//
// Deliberately dumb: it takes an already-resolved param bag and drops the
// empties. Deciding WHICH params a screen carries (and what its defaults are)
// stays with the screen.

export type SortDir = "asc" | "desc";

/**
 * Values that mean "not in the URL" and are dropped:
 *   undefined | null | "" | false | 0
 *
 * `0` is dropped on purpose — the only numeric param the lists carry is
 * `offset`, and `?offset=0` is exactly the default. A future numeric param for
 * which 0 is meaningful must be stringified by the caller first.
 */
export type ListParam = string | number | boolean | null | undefined;

export function buildListHref(path: string, params: Record<string, ListParam>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === false || value === 0)
      continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Coerce a raw `?dir=` param; anything unrecognised falls back. */
export function parseSortDir(v: unknown, fallback: SortDir = "desc"): SortDir {
  return v === "asc" || v === "desc" ? v : fallback;
}

/** Coerce a raw `?sort=` param against a screen's allow-list; "" = default order. */
export function parseSortKey<T extends string>(v: unknown, allowed: readonly T[]): T | "" {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : "";
}

/**
 * The direction a header click should produce.
 *
 * Clicking the ACTIVE column flips it; clicking an inactive one starts at that
 * column's own default (dates and counts read newest/biggest-first, names
 * A→Z), which is what makes one click on "Published" do the obvious thing
 * rather than showing the oldest post in the library.
 */
export function nextSortDir(
  column: string,
  activeSort: string,
  activeDir: SortDir,
  columnDefaultDir: SortDir,
): SortDir {
  if (column !== activeSort) return columnDefaultDir;
  return activeDir === "asc" ? "desc" : "asc";
}

/** `aria-sort` for a column header — "none" unless this column is the active one. */
export function ariaSortFor(
  column: string,
  activeSort: string,
  activeDir: SortDir,
): "ascending" | "descending" | "none" {
  if (column !== activeSort) return "none";
  return activeDir === "asc" ? "ascending" : "descending";
}

/** Generic comparator for JS-side sorting of already-materialised list rows. */
export function compareValues(a: unknown, b: unknown, dir: SortDir): number {
  // Nulls always sink, in both directions: a row with no last post is not
  // "the earliest", it is unknown, and floating it to the top of an ascending
  // sort buries every row the operator actually asked to see.
  const aEmpty = a === null || a === undefined || a === "";
  const bEmpty = b === null || b === undefined || b === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  let cmp: number;
  if (typeof a === "number" && typeof b === "number") cmp = a - b;
  else cmp = String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true });

  return dir === "asc" ? cmp : -cmp;
}
