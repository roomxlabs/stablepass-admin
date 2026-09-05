import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";
import { dispatchNewPost } from "@/lib/push/dispatch";

// POST /api/admin/posts/:id/publish — flip a draft/scheduled post to published,
// stamp published_at, then fan out a `new_post` push via the be push-dispatch
// function (T2). push-dispatch runs service-role internally; we invoke it with
// the admin session — the client never holds elevated credentials.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;

  const { data: post } = (await sb
    .from("post")
    .select("id,horse_id,status,title,body,published_at")
    .eq("id", id)
    .maybeSingle()) as {
    data: {
      id: string;
      horse_id: string;
      status: string;
      title: string | null;
      body: string | null;
      published_at: string | null;
    } | null;
  };
  if (!post) return fail("not_found", "Post not found.", 404);
  if (post.status !== "draft" && post.status !== "scheduled")
    return fail("invalid_status", `A ${post.status} post cannot be published.`, 409);

  // Defence-in-depth: a post that has EVER been published (published_at
  // non-null) must never re-notify members, even if a future ticket adds a
  // back-to-draft transition (today there is none — `unpublish` writes
  // `unpublished`, `republish` goes unpublished -> published without
  // dispatching, and PATCH's FIELD_MAP has no `status` key, so `published_at`
  // is never NULLed). The atomic `.in("status", ...)` update below is what
  // closes the actual concurrency hole.
  const firstPublish = post.published_at === null || post.published_at === undefined;

  // Re-assert the status precondition on the write itself, scoped to the same
  // draft/scheduled statuses checked above: two concurrent publishes (an
  // operator double-click, or an admin request racing the be
  // `scheduled-post-publisher` cron flipping the same due `scheduled` row)
  // could both read `published_at: null` and both dispatch, double-notifying
  // every member. Scoping the UPDATE by `.in("status", ...)` means only the
  // request that actually wins the flip affects a row; the loser gets 0 rows
  // back and must not dispatch.
  const { data: updated, error } = await sb
    .from("post")
    .update({ status: "published", published_at: new Date().toISOString(), scheduled_for: null })
    .eq("id", id)
    .in("status", ["draft", "scheduled"])
    .select("id,status,published_at")
    .maybeSingle();
  if (error) return fail("update_failed", error.message, 400);
  if (!updated)
    return fail("invalid_status", "This post was already published by another request.", 409);

  // Best-effort fan-out: a notification failure must not un-publish the post.
  let notificationsSent = 0;
  if (firstPublish) {
    // Parity with the be cron's `buildNewPostEvent` (scheduled-post-publisher):
    // `title`/`body` are nullable columns, so a caption-less photo post must
    // still fall back to a generic notification rather than silently sending
    // no push at all (push-dispatch 422s on empty title/body, which
    // `dispatchNewPost` swallows to 0).
    const title = post.title?.trim() || "New post";
    const body = post.body?.trim() || post.title?.trim() || "A new update is available.";
    notificationsSent = await dispatchNewPost(sb, {
      type: "new_post",
      horseId: post.horse_id,
      targetType: "post",
      targetId: post.id,
      title,
      body,
    });
  }

  return ok({ id: updated.id, status: updated.status, publishedAt: updated.published_at, notificationsSent });
}
