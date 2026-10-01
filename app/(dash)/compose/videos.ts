// ENG-1598 — the multi-video data layer for Compose (MV-A2).
//
// The video counterpart of `photos.ts`, and kept PURE for the same reason: the
// screen is 3k+ lines and trips the set-state-in-effect lint, so the rules that
// decide what the operator may do with a video set live here, where they are
// tested without a DOM.
//
// THE CONTRACT WE ARE CONSUMING (MV-A1, ENG-1597):
//   * `POST /api/admin/posts {videoCount}` mints one `post_video` row + one Mux
//     direct-upload target per slot → `uploads: [{videoId, uploadUrl}]`.
//   * `POST /api/admin/posts/:id/video-uploads {count}` appends slots.
//   * `PATCH /api/admin/posts/:id {videos:[ids…], knownVideos:[ids…]}` is the
//     WHOLE ordered set: ids left out are deleted (and their Mux asset), the
//     rest are renumbered 0..n-1. A new slot 0 has its `poster_time_s` cleared.
//   * publish / schedule / republish 409 `videos_not_ready` until EVERY row is
//     `ready`. The be mux-webhook (ENG-1595) is what flips a row to ready.
//
// Slot 0 is the COVER: the deferred trigger mirrors it onto `post`, so its
// poster is the one the feed shows and it is the only video with a frame
// chooser (owner decision).

/**
 * A post may carry at most this many videos. RESTATED rather than imported:
 * `lib/posts/videos.ts` pulls in `next/server` and the Mux client, neither of
 * which belongs in a client bundle. `videos.test.ts` pins the two equal.
 */
export const MAX_VIDEOS = 5;

/** How often the screen re-reads processing videos. */
export const VIDEO_POLL_MS = 3000;
/** The poll backs off to at most this when nothing changes (ENG-1598 review). */
export const VIDEO_POLL_MAX_MS = 30_000;

export type VideoTileState = "uploading" | "processing" | "ready" | "failed";

export type ComposeVideo = {
  /** Stable React key — never the index (a reorder would remount the <video>). */
  key: string;
  /**
   * The `post_video` row id. Null only for a create response that predates
   * MV-A1 (a bare top-level `uploadUrl`): such a tile cannot be polled,
   * reordered on the server or sent in `videos`, so it is treated as ready once
   * its bytes land — exactly the single-video behaviour before this ticket.
   */
  id: string | null;
  name: string;
  size: number;
  /** The picked file — kept for the slot-0 frame chooser and measurement. */
  file?: File;
  /** Local object URL (a fresh pick), or null for a video loaded from the post. */
  localUrl: string | null;
  /** Signed HLS URL for a video already on the post (edit mode), once known. */
  playbackUrl?: string | null;
  /** Signed poster/thumbnail once the server has one. */
  posterUrl?: string | null;
  state: VideoTileState;
  /** Byte-upload progress, 0..100. Only meaningful while `uploading`. */
  pct: number;
  error?: string;
};

/** A direct-upload target from the create / append routes. */
export type VideoUploadTarget = { videoId: string | null; uploadUrl: string };

/** One row of `GET /api/admin/posts/:id/videos`. */
export type VideoStatusRow = {
  id: string;
  sortOrder: number;
  status: string;
  posterUrl: string | null;
  playbackUrl: string | null;
};

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The cap, checked BEFORE anything is created or uploaded — "a 6th pick is
 * refused with the cap message". `current` counts every tile, including ones
 * still uploading or failed, because each already holds a slot.
 */
export function videoCapError(current: number, adding: number): string | null {
  if (current + adding <= MAX_VIDEOS) return null;
  return current === 0
    ? `You can add up to ${MAX_VIDEOS} videos to a post — you picked ${adding}. Nothing was uploaded.`
    : `You can add up to ${MAX_VIDEOS} videos to a post — this would make ${current + adding}. Nothing was uploaded.`;
}

/**
 * Videos only: a photo dragged in with three videos is an error the operator
 * resolves, never a silent mixed post (the API has no such thing).
 */
export function nonVideoError(files: readonly { name: string; type: string }[]): string | null {
  const wrong = files.find((f) => !f.type.startsWith("video/"));
  if (!wrong) return null;
  return `You chose Video, but “${wrong.name}” is ${wrong.type ? `a ${wrong.type} file` : "an unrecognised file"}. Pick video files only — a post can't mix photos and videos.`;
}

/**
 * The upload targets a create/append response carries, in slot order.
 *
 * Falls back to the single top-level `uploadUrl` a pre-MV-A1 route returns
 * (id null — see `ComposeVideo.id`). Anything malformed is dropped, and the
 * caller refuses a pick whose target count does not match what was picked.
 */
export function videoUploadTargets(created: {
  uploadUrl?: string;
  uploads?: unknown;
}): VideoUploadTarget[] {
  const raw = Array.isArray(created.uploads) ? (created.uploads as unknown[]) : [];
  const targets = raw.flatMap((u) => {
    const t = u as { videoId?: unknown; uploadUrl?: unknown };
    return typeof t?.videoId === "string" && typeof t?.uploadUrl === "string"
      ? [{ videoId: t.videoId, uploadUrl: t.uploadUrl }]
      : [];
  });
  if (targets.length > 0) return targets;
  return created.uploadUrl ? [{ videoId: null, uploadUrl: created.uploadUrl }] : [];
}

/** A straight two-element swap — the same move (and the same reasoning) as `movePhoto`. */
export function moveVideo(
  list: readonly ComposeVideo[],
  index: number,
  direction: -1 | 1,
): ComposeVideo[] {
  const target = index + direction;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) {
    return list as ComposeVideo[];
  }
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function removeVideoAt(list: readonly ComposeVideo[], index: number): ComposeVideo[] {
  if (index < 0 || index >= list.length) return list as ComposeVideo[];
  return list.filter((_, i) => i !== index);
}

/**
 * Did the COVER change? When it does the frame chooser moves to the new first
 * video and the picked frame is dropped — the API clears the new slot 0's
 * `poster_time_s` too (MV-A1), so keeping the old pick would send a time that
 * belongs to a different clip.
 */
export function slot0Changed(prev: readonly ComposeVideo[], next: readonly ComposeVideo[]): boolean {
  return (prev[0]?.key ?? null) !== (next[0]?.key ?? null);
}

/** Patch one tile by key; a tile that has since been removed is simply not found. */
export function updateVideo(
  list: readonly ComposeVideo[],
  key: string,
  patch: Partial<ComposeVideo>,
): ComposeVideo[] {
  let hit = false;
  const next = list.map((v) => {
    if (v.key !== key) return v;
    hit = true;
    return { ...v, ...patch };
  });
  return hit ? next : (list as ComposeVideo[]);
}

/**
 * Fold a status read into the tiles.
 *
 * Only tiles whose bytes have LANDED move: a tile still `uploading` is the
 * browser's to settle (the server row says "uploading" for it too), and a tile
 * whose PUT failed stays failed — the server would otherwise report it
 * "uploading" forever and the operator would wait on nothing. A row the read
 * does not return is left alone; the set only changes by the operator's hand.
 */
export function applyServerStatus(
  list: readonly ComposeVideo[],
  rows: readonly VideoStatusRow[],
): ComposeVideo[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  let changed = false;
  const next = list.map((v) => {
    const row = v.id ? byId.get(v.id) : undefined;
    if (!row || v.state === "uploading" || v.state === "failed") return v;
    const state: VideoTileState =
      row.status === "ready" ? "ready" : row.status === "errored" ? "failed" : "processing";
    const posterUrl = row.posterUrl ?? v.posterUrl ?? null;
    const playbackUrl = row.playbackUrl ?? v.playbackUrl ?? null;
    const error = state === "failed" ? "Mux couldn't process this video." : undefined;
    if (
      state === v.state &&
      posterUrl === (v.posterUrl ?? null) &&
      playbackUrl === (v.playbackUrl ?? null)
    ) {
      return v;
    }
    changed = true;
    return { ...v, state, posterUrl, playbackUrl, error };
  });
  return changed ? next : (list as ComposeVideo[]);
}

/** The ids to poll: tiles whose bytes landed and are waiting on Mux. */
export function pollableIds(list: readonly ComposeVideo[]): string[] {
  return list.filter((v) => v.id && v.state === "processing").map((v) => v.id!);
}

export function anyUploading(list: readonly ComposeVideo[]): boolean {
  return list.some((v) => v.state === "uploading");
}

/** "Waiting for N videos to finish processing" — shared with the 409 path. */
export function waitingMessage(n: number): string {
  return `Waiting for ${plural(n, "video")} to finish processing`;
}

/**
 * Why Publish / Schedule are disabled, or null when they may go. Failed tiles
 * are named first: they will never become ready, so "waiting" would be a lie.
 */
export function videoBlockReason(list: readonly ComposeVideo[]): string | null {
  if (list.length === 0) return "A video post needs at least one video.";
  const failed = list.filter((v) => v.state === "failed").length;
  if (failed > 0) {
    return failed === 1
      ? "A video failed. Remove it and re-add it to publish."
      : `${failed} videos failed. Remove them and re-add them to publish.`;
  }
  const pending = list.filter((v) => v.state !== "ready").length;
  return pending > 0 ? waitingMessage(pending) : null;
}

/**
 * Why an edit SAVE is refused, or null. Looser than publishing: a published
 * post may keep a newly added video processing (members see it once it is
 * ready, MV-B3). But not while bytes are still in the air (the save would ship
 * a set whose last row never gets its file), not with a failed tile left in it,
 * not empty (`invalid_video_set`), and not with a not-ready video as the COVER
 * of a live post — the route 409s that because it would blank the feed video.
 */
export function videoSaveBlockReason(
  list: readonly ComposeVideo[],
  opts: { live: boolean },
): string | null {
  if (list.length === 0) return "A video post needs at least one video.";
  if (anyUploading(list)) return "A video is still uploading. Wait for it to finish, or remove it.";
  if (list.some((v) => v.state === "failed"))
    return "A video failed. Remove it before saving, then re-add it.";
  if (opts.live && list[0].state !== "ready")
    return "The first video of a live post must be ready. Move a ready video to the front.";
  return null;
}

/**
 * The `videos` / `knownVideos` fragment every save spreads in — ABSENT unless
 * the local order differs from what the server holds, like `labelPatch`.
 *
 * `serverIds` is the ordered set the server holds as far as this session
 * knows (loaded + minted, minus what a successful save removed). Sent back as
 * `knownVideos`, so a concurrent add/remove by another admin 409s
 * (`video_set_stale`) instead of silently reordering a set nobody saw. A
 * legacy id-less tile makes the set unaddressable, so nothing is sent.
 */
export function videoOrderPatch(
  list: readonly ComposeVideo[],
  serverIds: readonly string[],
): { videos?: string[]; knownVideos?: string[] } {
  if (list.length === 0 || list.some((v) => !v.id)) return {};
  const ids = list.map((v) => v.id!);
  const same = ids.length === serverIds.length && ids.every((id, i) => id === serverIds[i]);
  return same ? {} : { videos: ids, knownVideos: [...serverIds] };
}

/**
 * ENG-1611 — the MV-A1 PATCH refuses a set whose `knownVideos` no longer
 * matches the server (another admin added or removed a video meanwhile) with
 * `409 video_set_stale`. Structural, like `videosNotReadyMessage`.
 */
export function isVideoSetStale(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: unknown }).code === "video_set_stale";
}

/** What the operator reads once the server set has been reloaded into the tiles. */
export const VIDEO_SET_STALE_MESSAGE = "This post's videos changed elsewhere — reloaded";
/** …and when the reload itself failed: the tiles are left as they were. */
export const VIDEO_SET_STALE_RELOAD_FAILED =
  "This post's videos changed elsewhere. Reload the page to see the current set.";

/**
 * ENG-1611 — replace the tiles with the SERVER's set after a `video_set_stale`,
 * in the server's slot order. A tile the server still holds keeps its key and
 * local media (no remount, the blob keeps playing) and takes the server's
 * status by the same rules as the poll; a row this screen never saw becomes a
 * fresh tile. `dropped` is every local tile the server no longer holds
 * (including a legacy id-less one), for the caller to abort + revoke.
 */
export function reloadVideoSet(
  list: readonly ComposeVideo[],
  rows: readonly VideoStatusRow[],
): { tiles: ComposeVideo[]; dropped: ComposeVideo[] } {
  const ordered = [...rows].sort((a, b) => a.sortOrder - b.sortOrder);
  const byId = new Map(list.flatMap((v) => (v.id ? [[v.id, v] as const] : [])));
  const tiles = ordered.map((row) => {
    const mine = byId.get(row.id);
    return mine ? applyServerStatus([mine], [row])[0] : tileFromRow(row);
  });
  const kept = new Set(ordered.map((r) => r.id));
  const dropped = list.filter((v) => !v.id || !kept.has(v.id));
  return { tiles, dropped };
}

/** An existing `post_video` row → a tile (edit mode). */
export function tileFromRow(row: VideoStatusRow): ComposeVideo {
  const state: VideoTileState =
    row.status === "ready" ? "ready" : row.status === "errored" ? "failed" : "processing";
  return {
    key: `existing-${row.id}`,
    id: row.id,
    name: `Video ${row.sortOrder + 1}`,
    size: 0,
    localUrl: null,
    playbackUrl: row.playbackUrl,
    posterUrl: row.posterUrl,
    state,
    pct: state === "processing" ? 100 : 0,
    error: state === "failed" ? "Mux couldn't process this video." : undefined,
  };
}

/** The word under a tile. */
export function tileStateLabel(v: ComposeVideo): string {
  switch (v.state) {
    case "uploading":
      return v.pct > 0 ? `uploading ${v.pct}%` : "uploading…";
    case "processing":
      return "processing…";
    case "ready":
      return "ready";
    default:
      return "failed — remove and re-add";
  }
}

/** The slot-0 source the Step 3 frame and slide 1 of the preview play. */
export function coverSource(v: ComposeVideo | undefined): string | null {
  if (!v) return null;
  return v.localUrl ?? v.playbackUrl ?? null;
}
