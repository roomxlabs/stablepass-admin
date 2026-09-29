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
import {
  muxSignedStreamUrl,
  muxSignedThumbnailUrl,
  reconcilePostVideos,
  type PostVideoWriteDb,
} from "@/lib/mux-playback";

export type VideoStatus = {
  id: string;
  sortOrder: number;
  status: "uploading" | "ready" | "errored";
  posterUrl: string | null;
  playbackUrl: string | null;
};

/** The poll may reconcile against Mux at most this often per post. */
export const RECONCILE_MIN_INTERVAL_MS = 30_000;
const lastReconcileAt = new Map<string, number>();

/**
 * ENG-1598 review — the poll's reconcile throttle. True (and the slot is
 * claimed) when this post has not reconciled in the last 30s on this
 * instance, so a fresh create can reach `ready` without the webhook while a
 * 3s poll still costs at most one Mux listing per 30s. Best-effort per server
 * instance, which is all a fallback path needs.
 */
export function claimReconcileSlot(postId: string, now: number = Date.now()): boolean {
  const last = lastReconcileAt.get(postId);
  if (last !== undefined && now - last < RECONCILE_MIN_INTERVAL_MS) return false;
  lastReconcileAt.set(postId, now);
  if (lastReconcileAt.size > 500) {
    for (const [k, t] of lastReconcileAt) if (now - t >= RECONCILE_MIN_INTERVAL_MS) lastReconcileAt.delete(k);
  }
  return true;
}

/** Test seam: forget every claimed slot. */
export function resetReconcileThrottle(): void {
  lastReconcileAt.clear();
}

/**
 * The post's video rows, in slot order, with display media signed.
 *
 * `opts.reconcile` gates the ONE place this can call Mux: when true and a row
 * has no stored `mux_playback_id` yet, `reconcilePostVideos` lists the recent
 * Mux assets ONCE, matches each row by passthrough (= its own id, ENG-1597;
 * a backfilled legacy row falls back to `post.id`) and WRITES the match onto
 * the row (guarded only-if-null, `status: "ready"`), so the publish gate and
 * the slot-0 mirror see it. The poll passes it at most every 30s per post
 * (`claimReconcileSlot`); every other poll is a pure DB read.
 */
export async function readPostVideoStatus(
  sb: SupabaseClient,
  postId: string,
  opts?: { reconcile?: boolean },
): Promise<{ videos: VideoStatus[] } | { unavailable: true } | { error: true }> {
  const { data, error } = await sb
    .from("post_video")
    // mux_upload_id is read ONLY to spot a backfilled legacy row for the
    // reconcile; it is never returned (guardrail #8).
    .select("id,sort_order,status,mux_upload_id,mux_playback_id,poster_url,created_at")
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
    mux_upload_id: string | null;
    mux_playback_id: string | null;
    poster_url: string | null;
    created_at: string | null;
  }[];

  const reconciled = opts?.reconcile
    ? await reconcilePostVideos(sb as unknown as PostVideoWriteDb, postId, rows)
    : new Map<string, { playbackId: string }>();

  // One round-trip for every stored poster path, keyed by the original value.
  const posterMap = await signPhotoMap(sb, POST_MEDIA_BUCKET, rows.map((r) => r.poster_url));

  const videos: VideoStatus[] = [];
  for (const r of rows) {
    const written = reconciled.get(r.id);
    const status: VideoStatus["status"] = written
      ? "ready"
      : r.status === "ready" || r.status === "errored"
        ? r.status
        : "uploading";

    const playbackId = r.mux_playback_id ?? written?.playbackId ?? null;
    const playbackUrl: string | null = playbackId ? muxSignedStreamUrl(playbackId) : null;

    const signedPoster = r.poster_url ? posterMap.get(r.poster_url) ?? null : null;
    const posterUrl =
      signedPoster ?? (playbackId && status === "ready" ? muxSignedThumbnailUrl(playbackId) : null);

    videos.push({ id: r.id, sortOrder: r.sort_order, status, posterUrl, playbackUrl });
  }

  return { videos };
}
