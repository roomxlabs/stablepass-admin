import { requireAdmin } from "@/lib/auth/admin";
import { created, fail } from "@/lib/api/envelope";
import {
  MAX_VIDEOS,
  loadPostVideos,
  mintVideoUploads,
  isSlotConflict,
  isSlotRange,
} from "@/lib/posts/videos";

// POST /api/admin/posts/:id/video-uploads  { count } → signed Mux direct
// upload targets for `count` NEW video slots on an existing video post
// (ENG-1597 — the video counterpart of `[id]/photo-uploads`).
//
// Why this exists: `POST /api/admin/posts` mints every target at CREATE time
// from `videoCount`, so once the draft exists there is no way to get another
// one. "Add more videos" — whether the post is still a draft or already
// published — needs its own minting endpoint, exactly as photo-uploads does
// for photos.
//
// Allowed on ANY post status: a published video post can grow more slots
// (up to the cap) the same as a draft one; this route does not touch
// `post.status`.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const { sb } = g;
  const { id } = await params;

  const body = (await req.json().catch(() => null)) as { count?: unknown } | null;
  const count = body?.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_VIDEOS) {
    return fail("invalid_video_count", `count must be a whole number from 1 to ${MAX_VIDEOS}.`, 400);
  }

  const { data: post, error: postErr } = await sb
    .from("post")
    .select("id,type")
    .eq("id", id)
    .maybeSingle();
  if (postErr) {
    console.error("post query_failed", postErr.code);
    return fail("query_failed", "Could not load the post.", 400);
  }
  if (!post) return fail("not_found", "Post not found.", 404);
  if (post.type !== "video")
    return fail("not_video_post", "Videos can only be added to a video post.", 409);

  const { rows, error: videosErr } = await loadPostVideos(sb, id);
  if (videosErr) {
    console.error("post_video query_failed", videosErr.code);
    return fail("query_failed", "Could not load the post's videos.", 400);
  }

  if (rows.length + count > MAX_VIDEOS)
    return fail("video_cap", `A post can have at most ${MAX_VIDEOS} videos.`, 409);
  const next = rows.length ? Math.max(...rows.map((r) => r.sort_order)) + 1 : 0;
  if (next + count - 1 > MAX_VIDEOS - 1)
    return fail("video_cap", `A post can have at most ${MAX_VIDEOS} videos.`, 409);

  const insertRows = Array.from({ length: count }, (_, i) => ({
    post_id: id,
    sort_order: next + i,
    status: "uploading",
  }));
  const { data: inserted, error: insertErr } = await sb
    .from("post_video")
    .insert(insertRows)
    .select("id,sort_order");

  if (insertErr) {
    if (isSlotConflict(insertErr))
      return fail(
        "video_set_stale",
        "The post's videos changed. Refresh and try again.",
        409,
      );
    if (isSlotRange(insertErr))
      return fail("video_cap", `A post can have at most ${MAX_VIDEOS} videos.`, 409);
    console.error("post_video insert_failed", insertErr.code);
    return fail("insert_failed", "Could not create the post's videos.", 400);
  }

  const newRows = (((inserted ?? []) as { id: string; sort_order: number }[])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order));

  const mint = await mintVideoUploads(newRows, sb);
  if (!mint.ok) {
    await sb
      .from("post_video")
      .delete()
      .in("id", newRows.map((r) => r.id))
      .eq("post_id", id);
    return fail("mux_unavailable", "Mux is unavailable.", 502);
  }

  return created({ uploads: mint.uploads });
}
