import { requireAdmin } from "@/lib/auth/admin";
import { ok, noContent, fail } from "@/lib/api/envelope";
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin(); if ("res" in g) return g.res; const { sb } = g;
  const { id } = await params; const b = await req.json();
  const patch: Record<string, unknown> = {};
  for (const k of ["title", "body", "type", "expiresAt", "sourceTrainerId"]) if (k in b) patch[k === "expiresAt" ? "expires_at" : k === "sourceTrainerId" ? "source_trainer_id" : k] = b[k];
  const { data, error } = await sb.from("post").update(patch).eq("id", id).select("*").single();
  if (error) return fail("update_failed", error.message, 400);
  return ok(data);
}
// DELETE — discard a DRAFT only (hard delete). Published content is soft-hide only.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin(); if ("res" in g) return g.res; const { sb } = g;
  const { id } = await params;
  const { data: post } = await sb.from("post").select("status").eq("id", id).single();
  if (!post) return fail("not_found", "Post not found.", 404);
  if (post.status !== "draft") return fail("not_a_draft", "Only drafts can be discarded; published content is soft-hidden.", 409);
  await sb.from("post").delete().eq("id", id);
  return noContent();
}
