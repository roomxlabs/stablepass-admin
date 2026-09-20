import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";
import { dispatchNewPost } from "@/lib/push/dispatch";
import { isSubject } from "@/lib/posts/subject";

/**
 * The push-dispatch subject key for a post, or null when it must not dispatch.
 *
 * Returns the single-key object rather than a `{subject, id}` pair so the
 * `NewPostDispatch` union does the checking: spreading this into the payload
 * means a `horse` post can only ever produce `horseId` and a `trainer` post
 * only `trainerId`, and there is no expression here that could produce both.
 *
 * Null for `stablepass` (never dispatched), and null for a subject whose own
 * id column came back empty — a horse post with no `horse_id` is a row B1's
 * `post_subject_shape` CHECK should have made impossible, so the honest
 * outcome is "send nothing and log", not "send `horseId: null`" and have
 * push-dispatch 422 it into a silent 0.
 */
function subjectKey(post: {
  id: string;
  subject: string | null;
  horse_id: string | null;
  source_trainer_id: string | null;
}): { horseId: string } | { trainerId: string } | null {
  const subject = isSubject(post.subject) ? post.subject : "horse";
  if (subject === "stablepass") return null;
  if (subject === "trainer") {
    if (post.source_trainer_id) return { trainerId: post.source_trainer_id };
    console.error("publish: trainer post has no source_trainer_id, skipping push", post.id);
    return null;
  }
  if (post.horse_id) return { horseId: post.horse_id };
  console.error("publish: horse post has no horse_id, skipping push", post.id);
  return null;
}

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
    .select("id,subject,horse_id,source_trainer_id,status,title,body,published_at")
    .eq("id", id)
    .maybeSingle()) as {
    data: {
      id: string;
      // ENG-1269 — nullable since B1. `subject` says WHICH of the two id
      // columns is the one to key the push on; never infer it from which FK
      // happens to be populated (a trainer post legitimately carries neither a
      // horse nor, for `stablepass`, either one).
      subject: string | null;
      horse_id: string | null;
      source_trainer_id: string | null;
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

    // ENG-1269 / epic decision 5 — WHICH subject key (if any) this push carries.
    //
    // Driven by `post.subject`, not by which FK is populated: a trainer post
    // may legitimately carry no horse, and B1's default ('horse') is what
    // every pre-epic row reads back as, so the horse arm below is byte-for-byte
    // the payload this route has always sent.
    //
    // `stablepass` returns null and we DO NOT INVOKE AT ALL — not "invoke with
    // no key". push-dispatch 422s on a keyless new_post, and `dispatchNewPost`
    // swallows a 422 to 0, so a keyless invoke would look identical from here
    // while still burning a function call and logging an error on every
    // StablePass publish. The acceptance criterion is "invokes nothing".
    const key = subjectKey(post);
    if (key) {
      notificationsSent = await dispatchNewPost(sb, {
        ...key,
        type: "new_post",
        targetType: "post",
        targetId: post.id,
        title,
        body,
      });
    }
  }

  return ok({ id: updated.id, status: updated.status, publishedAt: updated.published_at, notificationsSent });
}
