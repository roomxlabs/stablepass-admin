import { requireAdmin } from "@/lib/auth/admin";
import { ok, noContent, fail } from "@/lib/api/envelope";
import { isLabelCheckViolation, LABEL_ERROR_MESSAGE, normalisePostLabel } from "@/lib/posts/labels";

// camelCase request field → post column.
const FIELD_MAP: Record<string, string> = {
  title: "title",
  body: "body",
  type: "type",
  expiresAt: "expires_at",
  sourceTrainerId: "source_trainer_id",
  // ENG-745. `null` is meaningful here and distinct from absent: sending
  // `label: null` CLEARS the category, while omitting the key leaves whatever
  // is on the row untouched — which is what keeps an old unlabelled post
  // unlabelled when the operator saves an edit without opening the picker.
  label: "label",
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

  // Validate the category against the preset list before it reaches the CHECK,
  // so an off-list value gets a readable 400 instead of a raw constraint error.
  if ("label" in b) {
    const labelValue = normalisePostLabel(b.label);
    if (labelValue === undefined)
      return fail("validation_failed", LABEL_ERROR_MESSAGE, 400);
    patch.label = labelValue;
  }

  const { data, error } = await sb.from("post").update(patch).eq("id", id).select("*").maybeSingle();
  // Backstop for a preset this build does not know about — same 400 as above,
  // never a 500 (guardrail: an editorial mistake is not a server fault).
  //
  // Scoped to the LABEL constraint by name, not to the bare 23514: `post` also
  // CHECKs `type`, `status` and `aspect_ratio`, and `type` is editable through
  // FIELD_MAP above with no validation of its own — so matching the code alone
  // reported every one of those as a label problem.
  if (isLabelCheckViolation(error))
    return fail("validation_failed", LABEL_ERROR_MESSAGE, 400);
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
