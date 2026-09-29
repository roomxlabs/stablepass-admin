import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";
import { isUuid } from "@/lib/uuid";
import { claimReconcileSlot, readPostVideoStatus } from "@/lib/posts/video-status";

// GET /api/admin/posts/:id/videos — the compose screen's multi-video status
// poll (ENG-1598): it hits this every few seconds while any of the post's
// `post_video` slots are still `uploading`.
//
// A pure DB read on almost every tick. The be `mux-webhook` (ENG-1595) is the
// primary writer of a row's `status`/`mux_playback_id`; as a fallback for when
// it has not delivered (local dev, webhook lag) the poll reconciles against Mux
// at most once per 30s per post (`claimReconcileSlot`) — one asset listing,
// and a guarded only-if-null write onto the matching `post_video` row, the same
// write the webhook does (ENG-1598 review, must-fix 1). It never returns a Mux
// asset/upload id (guardrail #8 — the browser only ever sees a signed
// poster/playback URL).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;

  if (!isUuid(id)) return fail("not_found", "Post not found.", 404);

  const result = await readPostVideoStatus(sb, id, { reconcile: claimReconcileSlot(id) });
  if ("error" in result) return fail("query_failed", "Could not load the post's videos.", 400);
  if ("unavailable" in result)
    return fail(
      "videos_unavailable",
      "Multi-video posts are not available until the backend migration is deployed.",
      503,
    );
  return ok({ videos: result.videos });
}
