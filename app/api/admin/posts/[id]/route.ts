import { requireAdmin } from "@/lib/auth/admin";
import { ok, noContent, fail } from "@/lib/api/envelope";

// camelCase request field → post column.
const FIELD_MAP: Record<string, string> = {
  title: "title",
  body: "body",
  type: "type",
  expiresAt: "expires_at",
  sourceTrainerId: "source_trainer_id",
};

// PATCH /api/admin/posts/:id — edit post fields (editable byline included).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;
  const b = await req.json().catch(() => ({}));

  const patch: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(FIELD_MAP)) if (field in b) patch[column] = b[field];
  if (Object.keys(patch).length === 0) return fail("validation_failed", "No editable fields provided.", 400);

  const { data, error } = await sb.from("post").update(patch).eq("id", id).select("*").maybeSingle();
  if (error) return fail("update_failed", error.message, 400);
  if (!data) return fail("not_found", "Post not found.", 404);
  return ok(data);
}

// DELETE /api/admin/posts/:id — discard a DRAFT only (hard delete). Published /
// scheduled / unpublished content is soft-hidden, never hard-deleted (guardrail §2).
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;

  const { data: post } = await sb.from("post").select("status").eq("id", id).maybeSingle();
  if (!post) return fail("not_found", "Post not found.", 404);
  if (post.status !== "draft")
    return fail("not_a_draft", "Only drafts can be discarded; published content is soft-hidden.", 409);

  // Scope the delete to draft too — defensive against a concurrent publish
  // landing between the check above and here (guardrail §2: never hard-delete a
  // published post).
  const { error } = await sb.from("post").delete().eq("id", id).eq("status", "draft");
  if (error) return fail("delete_failed", error.message, 400);
  return noContent();
}
