import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";
import { BYLINE_FIELDS, isRetired, type BylineRow } from "@/lib/posts/bylines";

/**
 * DELETE /api/admin/post-bylines/:id — retire a byline.
 *
 * Guardrail 2: retire, never a SQL delete. `post_byline_name_fk` is
 * `on delete restrict`, so a byline already referenced by a post could not be
 * hard-deleted anyway — but the point of retiring instead is that every
 * existing post keeps its byline text unchanged; retiring only hides the name
 * from Compose's picker for NEW posts.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;

  const { data: row, error: readError } = await sb
    .from("post_byline")
    .select(BYLINE_FIELDS)
    .eq("id", id)
    .maybeSingle();
  if (readError) {
    console.error("post_byline query_failed", readError.code);
    return fail("query_failed", "Could not load the byline.", 400);
  }
  if (!row) return fail("not_found", "That byline does not exist.", 404);

  // Idempotent: an already-retired row is left untouched, no mutation issued.
  if (isRetired(row as BylineRow)) return ok({ id, retired: true });

  const { error: updateError } = await sb
    .from("post_byline")
    .update({ retired_at: new Date().toISOString() })
    .eq("id", id)
    .select(BYLINE_FIELDS)
    .single();
  if (updateError) {
    console.error("post_byline update_failed", updateError.code);
    return fail("update_failed", "Could not retire the byline.", 400);
  }

  return ok({ id, retired: true });
}
