// Read-only `post_video` status for the compose screen's multi-video upload
// poll (ENG-1598). The compose screen calls this every few seconds while any
// slot is still `uploading`, so it must stay cheap: no Mux API call unless the
// caller explicitly asks to reconcile (see `opts.reconcile` below).
//
// Never returns a Mux asset/upload id — the browser only ever sees a signed
// poster/playback URL (guardrail #8, same rule `lib/posts/videos.ts` states
// for the write side).

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingVideoTable } from "@/lib/posts/videos";
import { POST_MEDIA_BUCKET, signPhotoMap } from "@/lib/storage/photos";
import { muxSignedStreamUrl, muxSignedThumbnailUrl, resolvePostVideoPlayback } from "@/lib/mux-playback";

export type VideoStatus = {
  id: string;
  sortOrder: number;
  status: "uploading" | "ready" | "errored";
  posterUrl: string | null;
  playbackUrl: string | null;
};

/**
 * The post's video rows, in slot order, with display media signed.
 *
 * `opts.reconcile` gates the ONE place this can call Mux: when true and a row
 * has no stored `mux_playback_id` yet, it asks `resolvePostVideoPlayback` to
 * look the asset up by passthrough (= the video's own id, ENG-1597). Callers
 * that poll this frequently must leave it unset/false so every poll stays a
 * pure DB read.
 */
export async function readPostVideoStatus(
  sb: SupabaseClient,
  postId: string,
  opts?: { reconcile?: boolean },
): Promise<{ videos: VideoStatus[] } | { unavailable: true } | { error: true }> {
  const { data, error } = await sb
    .from("post_video")
    .select("id,sort_order,status,mux_playback_id,poster_url")
    .eq("post_id", postId)
    .order("sort_order");

  if (error) {
    if (isMissingVideoTable(error)) return { unavailable: true };
    console.error("post_video query_failed", error.code);
    return { error: true };
  }

  const rows = (data ?? []) as {
    id: string;
    sort_order: number;
    status: string;
    mux_playback_id: string | null;
    poster_url: string | null;
  }[];

  // One round-trip for every stored poster path, keyed by the original value.
  const posterMap = await signPhotoMap(sb, POST_MEDIA_BUCKET, rows.map((r) => r.poster_url));

  const videos: VideoStatus[] = [];
  for (const r of rows) {
    const status: VideoStatus["status"] =
      r.status === "ready" || r.status === "errored" ? r.status : "uploading";

    let playbackId = r.mux_playback_id;
    let playbackUrl: string | null = playbackId ? muxSignedStreamUrl(playbackId) : null;
    if (!playbackId && opts?.reconcile) {
      const resolved = await resolvePostVideoPlayback({ id: r.id, mux_playback_id: null });
      playbackId = resolved.playbackId;
      playbackUrl = resolved.playbackUrl;
    }

    const signedPoster = r.poster_url ? posterMap.get(r.poster_url) ?? null : null;
    const posterUrl =
      signedPoster ?? (playbackId && status === "ready" ? muxSignedThumbnailUrl(playbackId) : null);

    videos.push({ id: r.id, sortOrder: r.sort_order, status, posterUrl, playbackUrl });
  }

  return { videos };
}
