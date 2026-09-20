/**
 * `post.subject` — WHO a post is posted as (ENG-1268 / B1's column).
 *
 * WHY THIS IS IN `lib/posts/` RATHER THAN IN THE COMPOSE SCREEN'S `types.ts`:
 * both the BFF routes and the screen have to agree on the three values and on
 * which types each may carry, and a route importing from `app/(dash)/compose/`
 * would point the server layer at a screen module. `lib/posts/labels.ts` split
 * out for exactly this reason under ENG-745; this is the same split for the
 * same pair of callers, so there is ONE definition and the picker cannot offer
 * a combination the route rejects.
 *
 * `app/(dash)/compose/types.ts` re-exports these rather than restating them.
 */

/**
 * `horse` is the DEFAULT and the back-compat value. B1's migration backfills
 * every pre-existing row to it, and a create request with no `subject` key at
 * all is a horse post — which is what keeps every caller that predates this
 * ticket byte-identical.
 */
export type Subject = "horse" | "trainer" | "stablepass";

/** The picker's order, left to right. */
export const SUBJECTS: readonly Subject[] = ["horse", "trainer", "stablepass"] as const;

/** Tile labels, also used in the edit-mode read-only row. */
export const SUBJECT_LABEL: Record<Subject, string> = {
  horse: "Horse",
  trainer: "Trainer",
  stablepass: "StablePass",
};

/**
 * Which post types each subject may author (epic decision 2).
 *
 * StablePass gets Photo and Video only. Compose HIDES the other two tiles
 * rather than disabling them — a disabled tile invites the operator to work
 * out why and there is no answer they can act on — and `POST /api/admin/posts`
 * rejects them regardless, because the BFF is not this endpoint's only caller.
 */
/**
 * The union is written out rather than imported as the screen's `MediaType`:
 * this module is the SHARED one and must not depend on a screen. The two are
 * structurally identical, so `types.ts`'s re-export lands as `MediaType[]`
 * where the screen needs it — and if `MediaType` ever gains a member, every
 * use here fails to compile rather than silently offering a type no subject
 * was given.
 */
export const TYPES_BY_SUBJECT: Record<Subject, readonly ("video" | "photo" | "voice" | "text")[]> = {
  horse: ["video", "photo", "voice", "text"],
  trainer: ["video", "photo", "voice", "text"],
  stablepass: ["photo", "video"],
};

export function subjectAllowsType(subject: Subject, type: string): boolean {
  return (TYPES_BY_SUBJECT[subject] as readonly string[]).includes(type);
}

/**
 * Is `value` one of the three? Guards a row read straight from the database
 * and an unvalidated request body alike — both are places a fourth string can
 * appear (an older build reading a newer column, or a hand-rolled caller).
 */
export function isSubject(value: unknown): value is Subject {
  return typeof value === "string" && (SUBJECTS as readonly string[]).includes(value);
}

/**
 * Line 1 of the StablePass preview head — the brand's own name, lowercase,
 * exactly as the wordmark sets it. Not the byline: the byline is line 2.
 */
export const STABLEPASS_HANDLE = "stablepass";
