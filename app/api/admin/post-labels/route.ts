import { requireAdmin } from "@/lib/auth/admin";
import { ok, created, fail } from "@/lib/api/envelope";
import {
  BANNED_LABEL_MESSAGE,
  isBannedLabel,
  MAX_LABEL_LENGTH,
} from "@/lib/posts/labels";

// The editorial categories Compose offers, read live from be's `post_label`
// lookup table (ENG-978) instead of from the compile-time copy in
// `lib/posts/labels.ts`.
//
// This route exists because ENG-978 turned `post.label` from a closed CHECK
// into a foreign key onto `public.post_label(name)`. The allowed set is now a
// TABLE, so the picker has to read the table — and Mel has to be able to add to
// it without a migration ("there'll be like one button here, Add New… it'll
// just grow as you post more").
//
// Guardrail 1: `requireAdmin()` first, on both verbs. Admin means an
// `app_user.is_admin=true` row AND an AAL2 session; the gate returns 401 with no
// session, 403 for a non-admin, and 403 `mfa_required` for an admin who has only
// cleared password auth. Writing the label vocabulary that appears on every
// member's feed is not something an AAL1 session may do.

/** Columns the picker needs. `id` is never sent to a member surface — `post.label` stores the NAME. */
const LABEL_FIELDS = "id,name,is_builtin,sort_order";

type LabelRow = { id: string; name: string; is_builtin: boolean; sort_order: number };

/**
 * Order the picker renders in: builtins first in be's seeded `sort_order`, then
 * everything an admin has added, alphabetically.
 *
 * Sorting by `sort_order` ALONE would be wrong: every admin-added row defaults
 * to `sort_order = 0` (per be's migration), so new labels would collate ahead of
 * the builtins in an arbitrary, insertion-dependent order. Ordering by
 * `is_builtin desc` first keeps the 14 known-good categories where operators
 * already expect them and gives the growing tail a stable, predictable order.
 */
function orderLabels(rows: LabelRow[]): LabelRow[] {
  return [...rows].sort((a, b) => {
    if (a.is_builtin !== b.is_builtin) return a.is_builtin ? -1 : 1;
    if (a.is_builtin) return a.sort_order - b.sort_order;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Fold a name for duplicate comparison.
 *
 * Case-insensitive AND whitespace-normalised, because the ticket's rule is that
 * a duplicate "differing only by case or trailing space" must return the
 * existing row rather than insert a second. `post_label.name` is `unique`, but
 * that unique index is byte-exact: Postgres would happily hold both "Trackwork"
 * and "trackwork" as two distinct categories, which is precisely the mess this
 * guards against. Inner runs of whitespace are collapsed too — "Race  Day" and
 * "Race Day" are the same category to a human, and a picker that lists both is
 * broken in the same way.
 */
function fold(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * GET /api/admin/post-labels — the live category list for Compose's picker.
 *
 * Returns rows, not just names, so the client can tell a pinned builtin from an
 * admin-added one.
 */
export async function GET() {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const { data, error } = await sb.from("post_label").select(LABEL_FIELDS);
  // Throw rather than degrade. An empty picker and a failed read look identical
  // in the UI, and the failure mode is worse than it sounds: an operator who
  // sees no categories concludes the feature is broken, or picks nothing and
  // ships an unlabelled post — the exact state this epic is removing.
  if (error) return fail("query_failed", error.message, 400);

  return ok(orderLabels((data ?? []) as LabelRow[]));
}

/**
 * POST /api/admin/post-labels — Add-new. Creates a category and returns it.
 *
 * IDEMPOTENT BY NAME. A duplicate that differs only by case or surrounding /
 * inner whitespace returns the EXISTING row with 200, and inserts nothing. This
 * is a required behaviour, not an optimisation: Add-new is a single interaction
 * that creates-and-selects, so an operator who types a category they already
 * have must end up selecting the one they have. Returning a 409 would leave
 * them with an error toast and no selection for a name that is, to them,
 * already correct.
 */
export async function POST(req: Request) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const b = await req.json().catch(() => ({}));
  if (typeof b?.name !== "string")
    return fail("validation_failed", "name is required.", 400);

  // Collapse inner whitespace as well as trimming the ends, so the row STORED
  // is the same shape the duplicate check compares. be's
  // `post_label_name_not_blank` constraint independently requires a btrim'd
  // name, so an untrimmed insert would be rejected by Postgres anyway.
  const name = b.name.trim().replace(/\s+/g, " ");
  if (name === "") return fail("validation_failed", "name is required.", 400);
  if (name.length > MAX_LABEL_LENGTH)
    return fail("validation_failed", `name must be ${MAX_LABEL_LENGTH} characters or fewer.`, 400);

  // Guardrail 6 — the preventive control. be's migration documents that it
  // deliberately did NOT ship a DB-level denylist (it could not, without the
  // banned tokens appearing in the migration text its own SQL linter greps for)
  // and left only a detective CI grep. This route is the sole way a
  // `post_label` row is authored, so it is where the check has to bite.
  if (isBannedLabel(name)) return fail("validation_failed", BANNED_LABEL_MESSAGE, 400);

  // Case/whitespace-insensitive existence check BEFORE inserting.
  //
  // Read the whole (small — tens of rows) set and fold in JS rather than
  // leaning on `.ilike()`: ilike would still miss the inner-whitespace case,
  // and its `%`/`_` wildcards would have to be escaped out of an
  // operator-supplied string to avoid "Race_Day" matching "Race Day".
  const { data: existingRows, error: readError } = await sb
    .from("post_label")
    .select(LABEL_FIELDS);
  if (readError) return fail("query_failed", readError.message, 400);

  const target = fold(name);
  const match = ((existingRows ?? []) as LabelRow[]).find((r) => fold(r.name) === target);
  // 200, not 201: nothing was created. The client selects `data.name` either
  // way, which is what makes Add-new idempotent from the operator's side.
  if (match) return ok(match);

  const { data, error } = await sb
    .from("post_label")
    .insert({ name, is_builtin: false, sort_order: 0 })
    .select(LABEL_FIELDS)
    .single();

  if (error) {
    // Lost a race with a concurrent Add-new of the same name. `name` is
    // `unique`, so Postgres is the real arbiter of the duplicate rule and the
    // read above is only a fast path. Re-read and hand back the winner rather
    // than failing the operator for losing a race they cannot see.
    if (error.code === "23505") {
      const { data: raced } = await sb.from("post_label").select(LABEL_FIELDS);
      const winner = ((raced ?? []) as LabelRow[]).find((r) => fold(r.name) === target);
      if (winner) return ok(winner);
      return fail("label_taken", "That label already exists.", 409);
    }
    return fail("insert_failed", error.message, 400);
  }

  return created(data);
}
