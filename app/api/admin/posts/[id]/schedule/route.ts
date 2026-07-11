import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";

// POST /api/admin/posts/:id/schedule — { scheduledFor } → status=scheduled.
// The scheduled time must be in the future; the auto-publish (and its fan-out)
// happens then, not here.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;

  const { scheduledFor } = await req.json().catch(() => ({}));
  if (!scheduledFor) return fail("validation_failed", "scheduledFor is required.", 400);
  const when = new Date(scheduledFor);
  if (Number.isNaN(when.getTime())) return fail("validation_failed", "scheduledFor is not a valid date.", 400);
  if (when.getTime() <= Date.now()) return fail("scheduled_for_in_past", "scheduledFor must be in the future.", 400);

  const { data: post } = await sb.from("post").select("status").eq("id", id).maybeSingle();
  if (!post) return fail("not_found", "Post not found.", 404);
  if (post.status !== "draft" && post.status !== "scheduled")
    return fail("invalid_status", `A ${post.status} post cannot be scheduled.`, 409);

  const { data: updated, error } = await sb
    .from("post")
    .update({ status: "scheduled", scheduled_for: when.toISOString() })
    .eq("id", id)
    .select("id,status,scheduled_for")
    .single();
  if (error || !updated) return fail("update_failed", error?.message ?? "Schedule failed.", 400);
  return ok({ id: updated.id, status: updated.status, scheduledFor: updated.scheduled_for });
}
