/**
 * The 13 editorial post-label presets — the ONE copy of the list in this repo.
 *
 * The single source of truth is `docs/specs/api-contract.md` in **stablepass-be**,
 * and the enforcement is the `post_label_preset` CHECK added by that repo's
 * `20260819120001_post_label.sql` (ENG-738). This file is a deliberate COPY of
 * that list, because admin cannot import across repos — and `labels.test.ts`
 * reads the contract doc off disk and asserts byte-equality with this array so
 * the copy cannot silently drift from the constraint.
 *
 * Two things that bite if you retype this list by hand instead of copying it:
 *
 *  1. `Race Day · Today` separates the words with a **U+00B7 MIDDLE DOT** (bytes
 *     `c2 b7`), NOT a hyphen and not a bullet. The CHECK is byte-exact.
 *  2. The list is CLOSED. An off-list write is rejected by Postgres as `23514`,
 *     which both admin post routes map to a 400 `validation_failed` — that
 *     mapping is the backstop for a value this constant never knew about (a
 *     preset removed by a later migration, say), so it must stay even though
 *     the routes also validate against this array up front.
 *
 * Guardrail 6 (no betting / bookmaker anything): the closed list is what makes
 * that true at the database, not the admin UI. Adding a 14th preset is a
 * migration in stablepass-be that alters the CHECK, then an update here.
 */
export const POST_LABEL_PRESETS = [
  "Stable Update",
  "Pre Race Report",
  "Post Race Report",
  "Trackwork",
  "Trial",
  "Race Replay",
  "Race Result",
  "Race Day · Today",
  "Pre Training Update",
  "Spelling Update",
  "Breaking In Update",
  "Race Preview",
  "Jockey Comments",
] as const;

export type PostLabel = (typeof POST_LABEL_PRESETS)[number];

/** Postgres check_violation — what an off-list `post.label` write raises. */
export const CHECK_VIOLATION = "23514";

/** True for a string that is exactly one of the 13 presets. */
export function isPostLabel(value: unknown): value is PostLabel {
  return typeof value === "string" && (POST_LABEL_PRESETS as readonly string[]).includes(value);
}

/**
 * Normalise a `label` off a request body to what the column takes.
 *
 * Returns the preset, or `null` for an explicit clear (`null` / `""`), or
 * `undefined` when the value is off-list — which the caller turns into a 400.
 * `undefined` is NOT "absent": callers must check `"label" in body` first,
 * because absent means "leave it alone" while `null` means "clear it".
 */
export function normalisePostLabel(value: unknown): PostLabel | null | undefined {
  if (value === null || value === "") return null;
  return isPostLabel(value) ? value : undefined;
}
