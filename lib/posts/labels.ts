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
 * that true at the database, not the admin UI. Adding a preset is a migration in
 * stablepass-be that alters the CHECK, then an update here.
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
  // 14th preset (Justin, 26 Aug 2026): stablepass-be migration
  // 20260826120300_post_label_trainer_comments alters the CHECK to match.
  "Trainer Comments",
] as const;

export type PostLabel = (typeof POST_LABEL_PRESETS)[number];

/** Postgres check_violation — what an off-list `post.label` write raises. */
export const CHECK_VIOLATION = "23514";

/**
 * The 400 message both routes return for a bad category.
 *
 * Exported rather than written out at each of the four call sites: it names the
 * list's LENGTH, so a 14th preset silently makes every inline copy a lie.
 */
export const LABEL_ERROR_MESSAGE = `label must be one of the ${POST_LABEL_PRESETS.length} presets, or null.`;

/** The CHECK constraint that enforces the preset list, by name. */
export const LABEL_CONSTRAINT = "post_label_preset";

/**
 * True only for a check_violation raised by `post_label_preset`.
 *
 * `23514` alone is NOT enough to blame the label: `post` carries several CHECKs
 * (`type`, `status`, `post_aspect_ratio_positive`, and this one), and `type` is
 * editable through `PATCH`'s FIELD_MAP with no validation of its own. Matching
 * on the bare code turned every one of those into "label must be one of the 13
 * presets", which is a worse error than the raw constraint message it replaced.
 * Postgres names the constraint in the message, and PostgREST passes it through.
 */
export function isLabelCheckViolation(error: {
  code?: string;
  message?: string;
  details?: string;
} | null): boolean {
  if (error?.code !== CHECK_VIOLATION) return false;
  return `${error.message ?? ""} ${error.details ?? ""}`.includes(LABEL_CONSTRAINT);
}

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
