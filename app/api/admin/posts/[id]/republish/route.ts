import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";

// POST /api/admin/posts/:id/republish — return an unpublished post to published
// (undo of unpublish). Only an unpublished post can be republished.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;

  const { data: post } = await sb.from("post").select("status").eq("id", id).maybeSingle();
  if (!post) return fail("not_found", "Post not found.", 404);
  if (post.status !== "unpublished")
    return fail("invalid_status", "Only an unpublished post can be republished.", 409);

  const { data: updated, error } = await sb
    .from("post")
    .update({ status: "published", unpublished_at: null })
    .eq("id", id)
    .select("id,status")
    .single();
  if (error || !updated) return fail("update_failed", error?.message ?? "Republish failed.", 400);
  return ok({ id: updated.id, status: updated.status });
}
