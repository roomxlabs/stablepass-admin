import { requireAdmin } from "@/lib/auth/admin";
import { noContent, fail } from "@/lib/api/envelope";

// DELETE /api/admin/posts/:id/delete — HARD delete a post of ANY status.
//
// A DELIBERATE, SCOPED EXCEPTION TO GUARDRAIL §2, not a replacement for it.
// §2's rule stands: `unpublish` is the reversible soft hide, and `DELETE
// /api/admin/posts/:id` (the sibling route) remains draft-only and still 409s a
// published post, so the guardrail's own test is untouched. This route exists
// because operator DATA CLEANUP — removing demo/seed content from production —
// has no other path: `post.horse_id` and `post.source_trainer_id` are both
// `not null` with no ON DELETE, so a demo horse or trainer can never be removed
// while a single demo post still points at it, whatever that post's status.
//
// It is therefore a separate URL with a separate UI affordance, labelled
// Delete (never Unpublish), behind its own confirmation. Everything that points
// at a post — bookmark, reaction, impression — cascades, so nothing blocks it.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;

  // Read first so a missing row is a 404 rather than a silent 204. Under admin
  // RLS a delete that matches nothing returns no error and no rows, which would
  // otherwise report "deleted" for an id that never existed.
  const { data: post, error: readErr } = await sb
    .from("post")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (readErr) return fail("delete_failed", readErr.message, 400);
  if (!post) return fail("not_found", "Post not found.", 404);

  const { error } = await sb.from("post").delete().eq("id", id);
  if (error) return fail("delete_failed", error.message, 400);
  return noContent();
}
