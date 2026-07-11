import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";

// POST /api/admin/posts/:id/publish — flip a draft/scheduled post to published,
// stamp published_at, then fan out a `new_post` push via the be push-dispatch
// function (T2). push-dispatch runs service-role internally; we invoke it with
// the admin session — the client never holds elevated credentials.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;

  const { data: post } = await sb
    .from("post")
    .select("id,horse_id,status,title,body")
    .eq("id", id)
    .maybeSingle();
  if (!post) return fail("not_found", "Post not found.", 404);
  if (post.status !== "draft" && post.status !== "scheduled")
    return fail("invalid_status", `A ${post.status} post cannot be published.`, 409);

  const { data: updated, error } = await sb
    .from("post")
    .update({ status: "published", published_at: new Date().toISOString(), scheduled_for: null })
    .eq("id", id)
    .select("id,status,published_at")
    .single();
  if (error || !updated) return fail("update_failed", error?.message ?? "Publish failed.", 400);

  // Best-effort fan-out: a notification failure must not un-publish the post.
  let notificationsSent = 0;
  try {
    const { data: dispatch } = await sb.functions.invoke("push-dispatch", {
      body: {
        type: "new_post",
        horseId: post.horse_id,
        targetType: "post",
        targetId: post.id,
        title: post.title,
        body: post.body,
      },
    });
    notificationsSent = (dispatch as { notificationsSent?: number } | null)?.notificationsSent ?? 0;
  } catch (e) {
    console.error("push-dispatch new_post failed", e);
  }

  return ok({ id: updated.id, status: updated.status, publishedAt: updated.published_at, notificationsSent });
}
