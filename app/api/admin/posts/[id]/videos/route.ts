import { requireAdmin } from "@/lib/auth/admin";
import { ok, fail } from "@/lib/api/envelope";
import { isUuid } from "@/lib/uuid";
import { readPostVideoStatus } from "@/lib/posts/video-status";

// GET /api/admin/posts/:id/videos — the compose screen's multi-video status
// poll (ENG-1598): it hits this every few seconds while any of the post's
// `post_video` slots are still `uploading`.
//
// READ-ONLY. The be `mux-webhook` (ENG-1595) is the only thing that flips a
// row's `status`/`mux_playback_id` — this route never calls Mux and never
// writes anything. It also never returns a Mux asset/upload id (guardrail #8
// — the browser only ever sees a signed poster/playback URL).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;

  if (!isUuid(id)) return fail("not_found", "Post not found.", 404);

  const result = await readPostVideoStatus(sb, id);
  if ("error" in result) return fail("query_failed", "Could not load the post's videos.", 400);
  if ("unavailable" in result)
    return fail(
      "videos_unavailable",
      "Multi-video posts are not available until the backend migration is deployed.",
      503,
    );
  return ok({ videos: result.videos });
}
