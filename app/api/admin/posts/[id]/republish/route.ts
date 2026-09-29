import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";
import { videoGate } from "@/lib/posts/videos";

// POST /api/admin/posts/:id/republish — return an unpublished post to published
// (undo of unpublish). Only an unpublished post can be republished.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;

  const { data: post } = await sb.from("post").select("status,type").eq("id", id).maybeSingle();
  if (!post) return fail("not_found", "Post not found.", 404);
  if (post.status !== "unpublished")
    return fail("invalid_status", "Only an unpublished post can be republished.", 409);

  // ENG-1597 — same publish gate: a video post going back live must not carry
  // an unfinished video either (e.g. an admin appended a replacement slot
  // while the post was unpublished).
  if (post.type === "video") {
    const gate = await videoGate(sb, id);
    if (gate) return gate;
  }

  const { data: updated, error } = await sb
    .from("post")
    .update({ status: "published", unpublished_at: null })
    .eq("id", id)
    .select("id,status")
    .single();
  if (error || !updated) return fail("update_failed", error?.message ?? "Republish failed.", 400);
  return ok({ id: updated.id, status: updated.status });
}
