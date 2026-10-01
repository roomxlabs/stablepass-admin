/**
 * The `post_video` write contract (ENG-1597 — multi-video, 1..5 per post).
 *
 * Mirrors `lib/posts/media.ts`'s role for `post_media`: the ONE copy of the
 * per-slot convention and the parsers both the create route, the append
 * route, and the PATCH reorder/remove path share, so the three cannot drift.
 *
 * The table (already migrated in stablepass-be):
 *   `post_video(id uuid pk, post_id fk post on delete cascade,
 *    sort_order int check 0..4, status text check in
 *    ('uploading','ready','errored'), mux_upload_id, mux_asset_id,
 *    mux_playback_id, poster_url, poster_time_s, aspect_ratio, ...,
 *    unique(post_id, sort_order) DEFERRABLE INITIALLY DEFERRED)`.
 *
 * A DEFERRED trigger mirrors the slot-0 row's mux_asset_id / mux_playback_id /
 * poster_url / poster_time_s / aspect_ratio onto `post` at COMMIT — so a
 * write that only touches `post` for those columns is overwritten by the next
 * `post_video` write, and any code that wants those fields sticking needs to
 * write them onto the post_video row, not (only) the post row.
 *
 * The deferrable unique on `(post_id, sort_order)` can NEVER be an `ON
 * CONFLICT` arbiter (Postgres requirement — an arbiter index must be
 * immediate), so nothing here ever upserts on `(post_id, sort_order)`. An
 * upsert on `id` (the PK, not deferred) is fine and is how a reorder swaps two
 * rows' sort_order in one statement without transiently colliding.
 */

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fail } from "@/lib/api/envelope";
import { createMuxDirectUpload, cleanupMuxVideo } from "@/lib/mux";
import { isUuid } from "@/lib/uuid";

/** A post may carry at most this many video slots (`sort_order` 0..4). */
export const MAX_VIDEOS = 5;

export type PostVideoRow = {
  id: string;
  sort_order: number;
  status: string;
  mux_upload_id: string | null;
  mux_asset_id: string | null;
  /** Lets the PATCH reorder tell a row it loaded from one its upsert re-created (ENG-1597). */
  created_at?: string;
};

/** String-literal projection — `.select()` field lists must be literals (repo convention). */
export const VIDEO_ROW_FIELDS = "id,sort_order,status,mux_upload_id,mux_asset_id,created_at";

/**
 * How many upload targets a create request wants. Absent/null → 1 (every
 * caller predating multi-video), so a single-video create stays byte-identical.
 * Anything other than a whole number 1..MAX_VIDEOS is rejected, not clamped.
 */
export function parseVideoCount(raw: unknown): number | null {
  if (raw === undefined || raw === null) return 1;
  if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
  if (raw < 1 || raw > MAX_VIDEOS) return null;
  return raw;
}

/**
 * The client's full ordered set of video ids (PATCH `videos`). Must be an
 * array of 1..MAX_VIDEOS distinct uuids — anything else is unusable and the
 * caller turns a null into a 400.
 */
export function parseVideoOrder(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length < 1 || raw.length > MAX_VIDEOS) return null;
  if (!raw.every((v) => isUuid(v))) return null;
  if (new Set(raw).size !== raw.length) return null;
  return raw as string[];
}

/**
 * True when the failure is "`post_video` is not there at all" — the same
 * deploy-order hazard `isMissingMediaTable` guards for `post_media`: admin
 * landing ahead of the be migration must not 500 on every video-post touch.
 */
export function isMissingVideoTable(
  error: { code?: string; message?: string } | null,
): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  const m = error.message ?? "";
  return /could not find the table/i.test(m) && m.includes("post_video");
}

/** Postgres unique_violation — a slot the client's stale view no longer matches. */
export function isSlotConflict(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

/** Postgres check_violation — a `sort_order` outside 0..4, or the video cap. */
export function isSlotRange(error: { code?: string } | null): boolean {
  return error?.code === "23514";
}

/** The post's video rows, in slot order. */
export async function loadPostVideos(
  sb: SupabaseClient,
  postId: string,
): Promise<{ rows: PostVideoRow[]; error: { code?: string; message?: string } | null }> {
  const { data, error } = await sb
    .from("post_video")
    .select(VIDEO_ROW_FIELDS)
    .eq("post_id", postId)
    .order("sort_order");
  return { rows: ((data as PostVideoRow[] | null) ?? []) as PostVideoRow[], error: error ?? null };
}

/**
 * Mint one Mux direct-upload target per row, in order, recording each
 * `mux_upload_id` back onto its `post_video` row as it goes.
 *
 * On ANY failure — Mux itself, or the DB write that records the upload id —
 * best-effort cleans up every upload minted so far, INCLUDING the one whose DB
 * write just failed (it did mint successfully at Mux; only our own record of
 * it failed). The caller owns rolling back the `post_video` rows themselves
 * (a delete, which cascades/atomically removes what this function touched).
 */
export async function mintVideoUploads(
  rows: { id: string }[],
  sb: SupabaseClient,
): Promise<
  | { ok: true; uploads: { videoId: string; uploadUrl: string }[] }
  | { ok: false; reason: "mux" | "db" }
> {
  const minted: { videoId: string; uploadId: string }[] = [];
  const uploads: { videoId: string; uploadUrl: string }[] = [];

  for (const row of rows) {
    let uploadId: string;
    let uploadUrl: string;
    try {
      const res = await createMuxDirectUpload({ passthrough: row.id });
      uploadId = res.uploadId;
      uploadUrl = res.uploadUrl;
    } catch {
      await Promise.all(
        minted.map((m) => cleanupMuxVideo({ videoId: m.videoId, uploadId: m.uploadId })),
      );
      return { ok: false, reason: "mux" };
    }

    minted.push({ videoId: row.id, uploadId });

    const { error } = await sb
      .from("post_video")
      .update({ mux_upload_id: uploadId })
      .eq("id", row.id);
    if (error) {
      await Promise.all(
        minted.map((m) => cleanupMuxVideo({ videoId: m.videoId, uploadId: m.uploadId })),
      );
      return { ok: false, reason: "db" };
    }

    uploads.push({ videoId: row.id, uploadUrl });
  }

  return { ok: true, uploads };
}

/** Best-effort Mux cleanup for a set of `post_video` rows. Never throws. */
export async function cleanupVideos(rows: PostVideoRow[]): Promise<void> {
  await Promise.all(
    rows.map((r) =>
      cleanupMuxVideo({ videoId: r.id, assetId: r.mux_asset_id, uploadId: r.mux_upload_id }),
    ),
  );
}

/**
 * The ids of a video post's not-yet-`ready` video rows, for the publish gate.
 *
 * A missing table (pre-deploy compat, same reasoning as `isMissingMediaTable`)
 * reads as "nothing to gate on" — proceeds rather than 400s — because a video
 * post created before this migration deployed has nowhere to store its rows
 * at all, and treating that as a permanent publish-block would be wrong.
 */
export async function notReadyVideoIds(
  sb: SupabaseClient,
  postId: string,
): Promise<{ notReady: string[] } | { error: true }> {
  const { data, error } = await sb
    .from("post_video")
    .select("id,status")
    .eq("post_id", postId)
    .order("sort_order");
  if (error) {
    if (isMissingVideoTable(error)) return { notReady: [] };
    console.error("post_video query_failed", error.code);
    return { error: true };
  }
  const rows = ((data as { id: string; status: string }[] | null) ?? []);
  return { notReady: rows.filter((r) => r.status !== "ready").map((r) => r.id) };
}

export function videosNotReadyResponse(notReady: string[]) {
  return NextResponse.json(
    {
      error: {
        code: "videos_not_ready",
        message: "Every video must finish processing before this post can go live.",
        notReady,
      },
    },
    { status: 409 },
  );
}

/** Combines the two above into the one call a publish/schedule/republish route makes. */
export async function videoGate(sb: SupabaseClient, postId: string): Promise<Response | null> {
  const result = await notReadyVideoIds(sb, postId);
  if ("error" in result) return fail("query_failed", "Could not check the post's videos.", 400);
  if (result.notReady.length > 0) return videosNotReadyResponse(result.notReady);
  return null;
}
