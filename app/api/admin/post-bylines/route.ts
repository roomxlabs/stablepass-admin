import { requireAdmin } from "@/lib/auth/admin";
import { ok, created, fail } from "@/lib/api/envelope";
import {
  BANNED_BYLINE_MESSAGE,
  BYLINE_FIELDS,
  bylineDuplicateKey,
  foldBylineName,
  isBannedByline,
  isRetired,
  MAX_BYLINE_LENGTH,
  orderBylines,
  toBylineDto,
  type BylineRow,
} from "@/lib/posts/bylines";

// The trainer/StablePass byline picker Compose offers (ENG-1263's post-subject
// epic), read live from `post_byline` — the same lookup-table shape
// `post_label` took under ENG-978/979, so this route mirrors
// `app/api/admin/post-labels/route.ts` closely.
//
// Guardrail 1: `requireAdmin()` first, on both verbs.
//
// Guardrail 6, scoped honestly: `isBannedByline` is the ONLY preventive
// control over what gets authored into `post_byline` — be's migration ships
// no DB-side filter at all here, not even the detective CI grep that
// backstops `post_label`. See `lib/posts/bylines.ts`.

/**
 * GET /api/admin/post-bylines — the live byline list for Compose's picker.
 *
 * Excludes retired rows: a retired byline is not offered for a NEW post, but
 *  its name stays on every post that already carries it — `post.byline` stores
 * the NAME, and retiring only stamps `post_byline.retired_at`.
 */
export async function GET() {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const { data, error } = await sb.from("post_byline").select(BYLINE_FIELDS).is("retired_at", null);
  if (error) {
    // Never put a Postgres error.message in a response body — log the code only.
    console.error("post_byline query_failed", error.code);
    return fail("query_failed", "Could not load the bylines.", 400);
  }

  return ok(orderBylines((data ?? []) as BylineRow[]).map(toBylineDto));
}

/**
 * POST /api/admin/post-bylines — Add-new. Creates a byline and returns it.
 *
 * CONTRACT DIFFERENCE FROM post-labels, DELIBERATE: a live duplicate here is a
 * 409, not a 200. post-labels' Add-new is idempotent-by-name because it is a
 * single create-and-select interaction; this ticket locks bylines to the
 * ordinary "that name is taken" behaviour instead.
 *
 * A duplicate whose only existing row is RETIRED is un-retired and returned
 * with 200 — re-adding a byline an admin previously retired restores the same
 * row (and the same id) rather than minting a twin.
 */
export async function POST(req: Request) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;

  const b = await req.json().catch(() => ({}));
  if (typeof b?.name !== "string") return fail("validation_failed", "name is required.", 400);

  const name = foldBylineName(b.name);
  if (name === "") return fail("validation_failed", "name is required.", 400);
  if (name.length > MAX_BYLINE_LENGTH)
    return fail("validation_failed", `name must be ${MAX_BYLINE_LENGTH} characters or fewer.`, 400);

  // Guardrail 6 — see the module doc comment above.
  if (isBannedByline(name)) return fail("validation_failed", BANNED_BYLINE_MESSAGE, 400);

  // Read ALL rows, retired included, so a retired duplicate can be found and
  // un-retired rather than treated as though it never existed.
  const { data: existingRows, error: readError } = await sb.from("post_byline").select(BYLINE_FIELDS);
  if (readError) {
    console.error("post_byline query_failed", readError.code);
    return fail("query_failed", "Could not load the bylines.", 400);
  }

  const key = bylineDuplicateKey(name);
  const match = ((existingRows ?? []) as BylineRow[]).find((r) => bylineDuplicateKey(r.name) === key);

  if (match) {
    if (isRetired(match)) {
      const { data: updated, error: updateError } = await sb
        .from("post_byline")
        .update({ retired_at: null })
        .eq("id", match.id)
        .select(BYLINE_FIELDS)
        .single();
      if (updateError) {
        console.error("post_byline update_failed", updateError.code);
        return fail("update_failed", "Could not restore the byline.", 400);
      }
      const restored = (updated ?? { ...match, retired_at: null }) as BylineRow;
      return ok(toBylineDto(restored));
    }
    return fail("byline_exists", "That byline already exists.", 409);
  }

  const { data, error } = await sb
    .from("post_byline")
    .insert({ name, sort_order: 0 })
    .select(BYLINE_FIELDS)
    .single();

  if (error) {
    // Lost a race with a concurrent Add-new of the byte-identical name — see
    // `lib/posts/labels.ts`'s equivalent comment for the full TOCTOU caveat.
    if (error.code === "23505") {
      const { data: raced } = await sb.from("post_byline").select(BYLINE_FIELDS);
      const winner = ((raced ?? []) as BylineRow[]).find((r) => bylineDuplicateKey(r.name) === key);
      if (winner) {
        if (isRetired(winner)) {
          const { data: updated, error: updateError } = await sb
            .from("post_byline")
            .update({ retired_at: null })
            .eq("id", winner.id)
            .select(BYLINE_FIELDS)
            .single();
          if (updateError) {
            console.error("post_byline update_failed", updateError.code);
            return fail("update_failed", "Could not restore the byline.", 400);
          }
          const restored = (updated ?? { ...winner, retired_at: null }) as BylineRow;
          return ok(toBylineDto(restored));
        }
        return fail("byline_exists", "That byline already exists.", 409);
      }
      return fail("byline_exists", "That byline already exists.", 409);
    }
    console.error("post_byline insert_failed", error.code);
    return fail("insert_failed", "Could not create the byline.", 400);
  }

  return created(toBylineDto(data as BylineRow));
}
