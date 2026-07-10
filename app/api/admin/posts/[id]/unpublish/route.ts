import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";

// POST /api/admin/posts/:id/unpublish — reversible soft hide (never a delete,
// guardrail §2). Only a published post can be unpublished.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;

  const { data: post } = await sb.from("post").select("status").eq("id", id).maybeSingle();
  if (!post) return fail("not_found", "Post not found.", 404);
  if (post.status !== "published")
    return fail("invalid_status", `A ${post.status} post cannot be unpublished.`, 409);

  const { data: updated, error } = await sb
    .from("post")
    .update({ status: "unpublished", unpublished_at: new Date().toISOString() })
    .eq("id", id)
    .select("id,status")
    .single();
  if (error || !updated) return fail("update_failed", error?.message ?? "Unpublish failed.", 400);
  return ok({ id: updated.id, status: updated.status });
}
