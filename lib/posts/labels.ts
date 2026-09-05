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
 * GAP NOW CLOSED (ENG-979). This used to read: "admin cannot yet POST with a
 * runtime-added label — `normalisePostLabel` rejects anything outside this
 * array, so the `23503` backstop below is unreachable through admin's own
 * surface." That is no longer true. `normalisePostLabel` now accepts any
 * trimmed, non-blank, non-gambling string, and `post_label` — via
 * `post_label_name_fk` — is what decides whether it exists. The `23503`
 * backstop is now the LIVE enforcement path, not dead code: an operator who
 * sends a label that is not in the table gets a 400 from it.
 *
 * That is the correct layering. This array cannot be the gate any more: the
 * whole point of ENG-978 + ENG-979 is that an admin adds a category at runtime,
 * so a validator pinned to a compile-time array would reject the very labels
 * the feature exists to create — and would do it before the database, which is
 * the only thing that actually knows the live set.
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
export const LABEL_ERROR_MESSAGE = `label must be one of the ${POST_LABEL_PRESETS.length} presets, a label you have added, or null.`;

/**
 * Guardrail 6 (no betting / bookmaker anything) — a MISTAKE-PREVENTION control
 * on the UI that authors category names.
 *
 * SCOPE, STATED HONESTLY (an earlier version of this comment overclaimed). This
 * is NOT a security boundary against an admin. be's migration grants
 * `insert, update, delete on public.post_label to authenticated` under the
 * `post_label_all_admin` policy, and admin ships a browser Supabase client, so
 * any AAL2 admin with devtools can insert a row straight through PostgREST and
 * never touch this code. Worse, `post_label_name_fk` is `on update cascade`, so
 * an existing non-builtin row can be RENAMED into gambling vocabulary and the
 * change cascades into `post.label` on every post carrying it — bypassing this
 * check and `post`'s own RLS. What this function actually buys is that a
 * good-faith operator cannot create such a category BY ACCIDENT through the
 * product. The database-side gap is wider than "no denylist on insert" and
 * belongs to ENG-994.
 *
 * Why this lives here, and why it is admin's job now. be's ENG-978 migration
 * dropped the closed `post_label_preset` CHECK, and its header states plainly
 * that a DB-level denylist "was considered and rejected: it cannot be written
 * in a migration without the tokens it bans appearing in this file's own text,
 * which `scripts/lint-sql.mjs` greps for and fails the build on". What be kept
 * is DETECTIVE — a CI test that greps live `post_label` rows after the fact.
 * ENG-994 is the open ticket asking whether that is enough.
 *
 * Admin has no such constraint, and admin's Add-new (ENG-979) is now the ONLY
 * way a `post_label` row gets authored. So the preventive control belongs
 * exactly here: at the point of authoring, before the row exists. A detective
 * grep that fires in CI tomorrow does not stop the label rendering on a
 * member's feed tonight.
 *
 * Word-boundary anchored so ordinary racing vocabulary survives: "Trackwork"
 * and "Trial" contain no banned token, and \b keeps "bet" from matching inside
 * a legitimate word. This is the same pattern `labels.test.ts` already applied
 * to the preset array — promoted to one exported copy so the array, the
 * request validator and the Add-new route cannot drift apart.
 */
export const BANNED_LABEL_PATTERN =
  /\b(gambl\w*|odds|bet|bets|betting|bettor\w*|bookmak\w*|bookie\w*|wager\w*|tip|tips|tipped|tipping|tipster\w*|punt|punts|punter\w*|punting|market|markets|stak(?:e|es|ing)\s*plan|bankroll|multi|multis|multibet|exotics|exacta|trifecta|quinella|quaddie|quadrella|parlay|accumulator|first\s+four|each[-\s]way|roughie\w*|blackbook|longshot\w*|sportsbet|betfair|ladbrokes|bet365|tab|neds|unibet|pointsbet|beteasy|betr|topsport|bluebet|palmerbet|betstar)\b/i;

/**
 * Characters that render as nothing (or as a normal space) but split a word in
 * two for a `\b`-anchored match.
 *
 * U+00AD SOFT HYPHEN is the important one and was missed by the first pass:
 * `Od\u00ADds` renders as "Odds" on a member's feed and matched nothing. The
 * rest is the Unicode default-ignorable set plus the variation selectors and
 * the Hangul filler characters, which are the usual stand-ins.
 */
const INVISIBLE_CHARS =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;

/**
 * Strip the tricks that let a banned word through a `\b`-anchored match.
 *
 * Two separate evasions, both of which defeated the first version of this
 * check (found in review, with a working bypass table):
 *
 *  1. COMPATIBILITY FORMS. `ｂｅｔｔｉｎｇ` in fullwidth Latin (U+FF42 …) is a
 *     different string to `betting` and matched nothing. NFKC folds those —
 *     and ligatures, and superscripts — onto their ASCII equivalents.
 *  2. ZERO-WIDTH INSERTIONS. `bett\u200Bing` renders as "betting" on a member's
 *     feed but contains a zero-width space, which breaks the word into two
 *     non-matching halves. They carry no meaning in a category name, so they
 *     are removed outright rather than treated as separators.
 *
 * NOT a claim of completeness. A determined admin can still defeat any
 * denylist (homoglyphs from other scripts — a Cyrillic `е` for a Latin `e` —
 * are the obvious remaining hole, and normalising those means confusable-script
 * detection, which is a much bigger hammer than this warrants). The threat model
 * here is an AAL2 operator typing a category in good faith, plus the plausible
 * near-misses; be's migration says the same thing about trusting an AAL2 admin.
 * The detective control (be's CI grep over live `post_label` rows, ENG-994)
 * remains the backstop for anything deliberate.
 */
function foldForBannedCheck(value: string): string {
  return value.normalize("NFKC").replace(INVISIBLE_CHARS, "");
}

/**
 * True for a label name that trips guardrail 6.
 *
 * Matches inflections by STEM where a stem is safe (`bookmak\w*` catches
 * bookmaker/bookmakers/bookmaking) and enumerates them where it is not: a bare
 * `bet\w*` would swallow "Better Days", so bet/bets/betting/bettor(s) are
 * listed individually. That asymmetry is the whole reason the original
 * enumerate-everything list leaked — `bookmaker` was listed but `Bookmakers`,
 * `Tipsters` and `Punters` were not, and those are what an operator would
 * actually type.
 */
export function isBannedLabel(value: string): boolean {
  return BANNED_LABEL_PATTERN.test(foldForBannedCheck(value));
}

/**
 * Fold a label name for DUPLICATE comparison — the one copy.
 *
 * Case-insensitive, whitespace-normalised (ends trimmed, inner runs collapsed)
 * and NFKC-normalised, so `Ｔrackwork` in fullwidth and a decomposed `Café`
 * (NFD) both fold onto the composed ASCII form rather than becoming a second
 * category that looks identical in the picker.
 *
 * Exported because three call sites need the SAME answer — the Add-new route's
 * pre-check, the name it stores, and the compose client — and three private
 * copies of a rule like this is how they silently disagree.
 */
export function foldLabelName(name: string): string {
  // Invisible characters are stripped here as well as in the guardrail check,
  // for two reasons: `Track\u200Bwork` would otherwise be a SECOND category that
  // looks identical to "Trackwork" in the picker, and the zero-width character
  // would be STORED in `post_label.name` and render on a member's feed inside a
  // string nobody can see is wrong.
  return name.normalize("NFKC").replace(INVISIBLE_CHARS, "").trim().replace(/\s+/g, " ");
}

/** The same fold, lowercased — what duplicate comparison actually compares. */
export function labelDuplicateKey(name: string): string {
  return foldLabelName(name).toLowerCase();
}

/**
 * Order labels for the picker: builtins first in be's seeded `sort_order`, then
 * admin-added ones alphabetically.
 *
 * Exported for the same reason as `foldLabelName`: the route and the compose
 * server page both render this list, and a comment asserting the two orderings
 * agree is exactly the claim that silently desyncs.
 *
 * Sorting by `sort_order` alone would be wrong — every admin-added row defaults
 * to 0, so new labels would collate ahead of the builtins in insertion order.
 */
export function orderLabels<T extends { name: string; is_builtin: boolean; sort_order: number }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    if (a.is_builtin !== b.is_builtin) return a.is_builtin ? -1 : 1;
    if (a.is_builtin) return a.sort_order - b.sort_order;
    return a.name.localeCompare(b.name);
  });
}

/**
 * The 400 an operator sees when Add-new (or a post write) carries a name that
 * trips guardrail 6.
 *
 * Deliberately names the RULE rather than the matched token — echoing the word
 * back is how a denylist teaches people to work around it.
 */
export const BANNED_LABEL_MESSAGE =
  "That label can\u2019t be used: StablePass carries no betting, odds or tipping content.";

/** Longest a label name may be. `post_label.name` is unbounded `text`; this is a UI-sanity cap. */
export const MAX_LABEL_LENGTH = 40;

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
 * CAVEAT (dead today, live the moment a label-management screen exists): the
 * match is a substring over message+details, so it also claims the OPPOSITE
 * direction of the same FK — `update or delete on table "post_label" violates
 * foreign key constraint "post_label_name_fk" on table "post"`, i.e. deleting a
 * label that posts still reference. That would be reported to the operator as
 * "label must be one of the N presets", which is wrong. No admin route writes
 * `post_label` today, so it is unreachable; whoever builds that screen must
 * narrow this.
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
 * Returns the trimmed name, or `null` for an explicit clear (`null` / `""` /
 * whitespace), or `undefined` when the value is unusable — which the caller
 * turns into a 400. `undefined` is NOT "absent": callers must check
 * `"label" in body` first, because absent means "leave it alone" while `null`
 * means "clear it".
 *
 * ENG-979 changed WHICH values are unusable. It used to be "anything not in
 * POST_LABEL_PRESETS". It is now only:
 *
 *   - a non-string (`42`, an object) — a type error, not a category;
 *   - a name longer than MAX_LABEL_LENGTH;
 *   - a name that trips guardrail 6 (see `isBannedLabel`).
 *
 * Everything else is passed through to Postgres, where `post_label_name_fk`
 * decides whether the label actually exists. That is deliberate and is the
 * whole point of the ticket: the live allowed set is whatever `post_label`
 * holds, and this module — a compile-time copy of be's seeded builtins — cannot
 * know it. A name that is well-formed but not in the table comes back as
 * `23503`, which `isLabelCheckViolation` recognises and both post routes
 * already map to a 400. So an unknown label is still rejected; it is just
 * rejected by the thing that has the answer.
 *
 * The trim matters beyond tidiness: `post_label_name_not_blank` requires
 * `name = btrim(name)`, so an untrimmed name could never match a stored row and
 * would fail the FK for a reason no operator could see.
 */
export function normalisePostLabel(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_LABEL_LENGTH) return undefined;
  // Guardrail 6 stays a hard reject here as well as on the Add-new route: a
  // post write is a second, independent way to put a name on a member's screen.
  if (isBannedLabel(trimmed)) return undefined;
  return trimmed;
}
