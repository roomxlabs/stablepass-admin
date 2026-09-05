/**
 * The post-label presets admin offers in its picker — the ONE copy in this repo.
 *
 * The source of truth is `docs/specs/api-contract.md` in **stablepass-be**, and
 * the enforcement is now that repo's `post_label` LOOKUP TABLE, seeded by
 * `20260904120000_post_label_table.sql` (ENG-978). This file is a deliberate
 * COPY of be's seeded builtins, because admin cannot import across repos, and
 * `labels.test.ts` reads be's contract doc + migration off disk to prove the
 * copy has not drifted from them.
 *
 * ## This list is a FLOOR, not a closed set (changed by ENG-978)
 *
 * Until ENG-978 a `post_label_preset` CHECK made the list closed, and adding a
 * label meant shipping a migration. That CHECK is GONE: `post.label` is now a
 * foreign key (`post_label_name_fk`) to `public.post_label(name)`, and an admin
 * adds a category by INSERTing a row — no migration. The live allowed set is
 * whatever `post_label` holds.
 *
 * So the 14 names below are be's **seeded builtins** — the floor every client
 * may assume, pinned permanently by be's `post_label_immutable_builtin` trigger
 * (a builtin cannot be renamed or deleted). They are NOT the whole set. The
 * drift guard therefore asserts these are PRESENT, never that they are
 * exhaustive: an exhaustive assertion would go red the first time Mel adds a
 * label, which is the feature ENG-978 exists to deliver.
 *
 * Two things that bite if you retype this list by hand instead of copying it:
 *
 *  1. `Race Day · Today` separates the words with a **U+00B7 MIDDLE DOT** (bytes
 *     `c2 b7`), NOT a hyphen and not a bullet. The FK compares bytes.
 *  2. An off-list write is rejected by Postgres as `23503` (foreign_key_violation
 *     — it was `23514` under the old CHECK), which both admin post routes map to
 *     a 400 `validation_failed`. That mapping is the backstop for a value this
 *     constant never knew about, so it must stay even though the routes also
 *     validate against this array up front.
 *
 * Guardrail 6 (no betting / bookmaker anything): with the CHECK gone, the
 * database no longer refuses a betting-flavoured category on its own — the
 * `post_label` row would simply be inserted. `labels.test.ts` keeps the
 * admin-side echo of that guardrail over this array.
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
  "Trainer Comments",
] as const;

export type PostLabel = (typeof POST_LABEL_PRESETS)[number];

/** Postgres check_violation — what an off-list `post.label` write raised BEFORE ENG-978. */
export const CHECK_VIOLATION = "23514";

/** Postgres foreign_key_violation — what an off-list `post.label` write raises NOW. */
export const FK_VIOLATION = "23503";

/**
 * The 400 message both routes return for a bad category.
 *
 * Exported rather than written out at each of the four call sites: it names the
 * list's LENGTH, so a new preset silently makes every inline copy a lie.
 *
 * "presets" rather than "the only allowed values" is deliberate — since ENG-978
 * an admin-inserted `post_label` row is valid too, so this array is the floor
 * admin's picker offers, not the closed set the database accepts.
 */
export const LABEL_ERROR_MESSAGE = `label must be one of the ${POST_LABEL_PRESETS.length} presets, or null.`;

/** The old CHECK constraint that enforced a closed preset list (dropped by ENG-978). */
export const LABEL_CONSTRAINT = "post_label_preset";

/** The foreign key to `post_label(name)` that replaced it (ENG-978). */
export const LABEL_FK_CONSTRAINT = "post_label_name_fk";

/**
 * True only for a constraint violation raised by the LABEL constraint.
 *
 * Matches both eras, keyed on code AND constraint name:
 *  - `23503` + `post_label_name_fk` — the live one. ENG-978 replaced the closed
 *    CHECK with a lookup table, so an unknown label is now a foreign-key
 *    violation, not a check violation.
 *  - `23514` + `post_label_preset` — the old CHECK. Kept so this still reports
 *    correctly against a database that has not yet run ENG-978's migration
 *    (a stale local/preview stack), rather than silently mapping it to a 500.
 *
 * The code alone is NOT enough to blame the label, in either era. `post` carries
 * several CHECKs (`type`, `status`, `post_aspect_ratio_positive`) and several
 * FKs (`trainer_id`, `horse_id`), and `type` is editable through `PATCH`'s
 * FIELD_MAP with no validation of its own. Matching on the bare code turned
 * every one of those into "label must be one of the presets", which is a worse
 * error than the raw constraint message it replaced. Postgres names the
 * constraint in the message, and PostgREST passes it through.
 */
export function isLabelCheckViolation(error: {
  code?: string;
  message?: string;
  details?: string;
} | null): boolean {
  const text = `${error?.message ?? ""} ${error?.details ?? ""}`;
  if (error?.code === FK_VIOLATION) return text.includes(LABEL_FK_CONSTRAINT);
  if (error?.code === CHECK_VIOLATION) return text.includes(LABEL_CONSTRAINT);
  return false;
}

/** True for a string that is exactly one of the presets admin offers. */
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
