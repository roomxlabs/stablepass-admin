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

/* -------------------------------------------------------------------------
 * subjectLabel — the ONE formatter for "who is this post by" (ENG-1269 / A4)
 * ---------------------------------------------------------------------- */

/**
 * The fields any caller can supply about a post's subject. Every one is
 * optional and nullable on purpose: this is fed by five different reads (the
 * posts-library row, the preview route, the dashboard's recently-published
 * table, per-post analytics, and the e2e fixtures), and each selects a
 * slightly different column set. A caller that cannot supply `byline` should
 * get a sensible `stablepass` label, not a crash.
 */
export type SubjectSource = {
  subject?: string | null;
  horseName?: string | null;
  trainerName?: string | null;
  byline?: string | null;
};

/**
 * A subject rendered into the parts a surface needs.
 *
 * WHY A STRUCT RATHER THAN A STRING: the posts library wants two lines plus a
 * tag element (`<strong>name</strong>` + a "Trainer" chip + a muted sub-line),
 * while the dashboard table cell, the analytics meta row and the preview
 * payload each want ONE string. Returning only a string would have forced the
 * table to re-split it, and returning only parts would have forced three
 * surfaces to re-join it differently — which is exactly how the horse name and
 * the trainer name drifted apart before this ticket. `text` is the canonical
 * flattening of `name`/`tag`/`detail`, so the two can never disagree.
 */
export type SubjectLabel = {
  /** The normalised subject — `horse` for anything unrecognised. */
  subject: Subject;
  /** Line 1: the name this post is posted as. Never empty. */
  name: string;
  /** A short chip beside `name` ("Trainer"), or null when the name speaks for itself. */
  tag: string | null;
  /** Line 2: supporting detail (the horse's trainer, or the StablePass byline). */
  detail: string | null;
  /** One-line flattening for surfaces with a single cell. Never empty. */
  text: string;
};

/**
 * Shown when a horse post's horse embed is missing. Pre-dates this ticket
 * (`mapPostRow` has said "Unassigned" since ENG-177) and is kept verbatim so a
 * horse post's cell is byte-identical to what it was before subjects existed.
 */
const HORSE_FALLBACK = "Unassigned";

/**
 * A trainer post whose trainer row did not come back. NOT "Unassigned": a
 * trainer post always HAS a trainer (B1's `post_subject_shape` CHECK requires
 * `source_trainer_id`), so a blank here means the embed failed, not that the
 * operator left it empty — and saying "Unassigned" would send an operator
 * hunting for a field to fill in that is already filled in.
 */
const TRAINER_FALLBACK = "Unknown trainer";

function clean(v: string | null | undefined): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
}

/**
 * The single formatter every admin surface uses to name a post's subject.
 *
 *   horse      → the horse's name, with its trainer underneath (unchanged).
 *   trainer    → the trainer's name, tagged "Trainer" so a trainer post is not
 *                mistaken for a horse whose name happens to be a person's.
 *   stablepass → `stablepass · <byline>` — the brand handle leads (it is who
 *                the post is from) and the byline qualifies it, matching the
 *                two-line preview head A3 shipped in compose.
 *
 * An unrecognised `subject` (an older build reading a newer column) degrades to
 * `horse`, which is the back-compat value and the one every pre-ENG-1263 row
 * carries.
 */
export function subjectLabel(p: SubjectSource): SubjectLabel {
  const subject: Subject = isSubject(p.subject) ? p.subject : "horse";
  const horseName = clean(p.horseName);
  const trainerName = clean(p.trainerName);
  const byline = clean(p.byline);

  if (subject === "trainer") {
    const name = trainerName ?? TRAINER_FALLBACK;
    return { subject, name, tag: SUBJECT_LABEL.trainer, detail: null, text: `${name} · Trainer` };
  }
  if (subject === "stablepass") {
    return {
      subject,
      name: STABLEPASS_HANDLE,
      tag: null,
      detail: byline,
      text: byline ? `${STABLEPASS_HANDLE} · ${byline}` : STABLEPASS_HANDLE,
    };
  }
  const name = horseName ?? HORSE_FALLBACK;
  return { subject, name, tag: null, detail: trainerName, text: name };
}
