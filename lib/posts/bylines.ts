/**
 * The trainer/StablePass byline picker's read/write helpers (ENG-1267).
 *
 * `post_byline` is a plain lookup table — no `is_builtin` column and no closed
 * preset array to drift-guard (its only CHECK is `post_byline_name_not_blank`,
 * which the fold below is what keeps writes inside). It exists to feed
 * `post.byline` — a TEXT column FK'd to `post_byline(name)` by
 * `post_byline_name_fk`, not an id FK — with a live, admin-managed name list,
 * the same shape `post_label` took under ENG-978/979.
 *
 * The duplicate/banned-name rules are NOT re-implemented here. A byline name
 * and a label name are folded and screened by the exact same logic — one copy
 * of that rule lives in `lib/posts/labels.ts`, and this module re-exports thin
 * wrappers over it rather than a second copy that could drift.
 */
import { foldLabelName, labelDuplicateKey, isBannedLabel } from "@/lib/posts/labels";

/** Longest a byline name may be. `post_byline.name` is unbounded `text`; this is a UI-sanity cap. */
export const MAX_BYLINE_LENGTH = 60;

/** Columns the picker needs. */
export const BYLINE_FIELDS = "id,name,sort_order,retired_at";

export type BylineRow = { id: string; name: string; sort_order: number; retired_at: string | null };

export type BylineDto = { id: string; name: string; sortOrder: number };

/**
 * Fold a byline name for storage/comparison — identical rule to a label's.
 *
 * The fold (NFKC, strip invisible characters, trim, collapse inner whitespace
 * runs) is not byline-specific, so it is imported rather than re-implemented:
 * two private copies of the same normalisation is how they silently disagree.
 */
export const foldBylineName = (name: string): string => foldLabelName(name);

/** The same fold, lowercased — what duplicate comparison actually compares. */
export const bylineDuplicateKey = (name: string): string => labelDuplicateKey(name);

/**
 * Guardrail 6 (no betting / bookmaker anything) for byline names.
 *
 * `post_byline` ships with NO DB-side filter at all per be's migration — not
 * even the detective CI grep that backstops `post_label` — so this route is
 * the ONLY preventive control over what can be authored as a byline. be's
 * control here is limited to whatever CI sweep it runs over live rows after
 * the fact; nothing stops a bad name reaching the table through this check.
 */
export const isBannedByline = (name: string): boolean => isBannedLabel(name);

/**
 * The 400 an operator sees when Add-new carries a name that trips guardrail 6.
 * Byline-worded, matching `BANNED_LABEL_MESSAGE`'s register and its U+2019
 * right single quote.
 */
export const BANNED_BYLINE_MESSAGE =
  "That byline can’t be used: StablePass carries no betting, odds or tipping content.";

/**
 * Order bylines for the picker: `sort_order` first, then name as a tiebreak.
 *
 * Ties on `sort_order` are legal per the column's comment (every admin-added
 * row defaults to the same value), so the name comparison exists purely to
 * make that case deterministic rather than dependent on read order.
 */
export function orderBylines<T extends { name: string; sort_order: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
}

export function toBylineDto(row: BylineRow): BylineDto {
  return { id: row.id, name: row.name, sortOrder: row.sort_order };
}

export function isRetired(row: { retired_at?: string | null }): boolean {
  return row.retired_at != null;
}
