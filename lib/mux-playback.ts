// Signed Mux playback for admin preview.
//
// Uploads are created with `playback_policy: ["signed"]` (subscription gate —
// video is never public), so playing one back requires a short-lived JWT
// minted with a Mux **signing key** (env: `MUX_SIGNING_KEY_ID` +
// `MUX_SIGNING_PRIVATE_KEY`, the base64-encoded PEM exactly as the Mux API
// returns it). Signing happens BFF-side only; the browser receives a
// ready-to-play `stream.mux.com/....m3u8?token=...` URL (guardrail §8:
// credentials never leave env).
//
// `resolveVideoPlayback` also reconciles `post.mux_playback_id` when the BE
// `mux-webhook` hasn't delivered (local dev / webhook lag): it looks the asset
// up by `passthrough = post.id` and performs the same guarded only-if-null
// UPDATE the webhook does, so the two writers can never fight.

import { createPrivateKey, createSign } from "node:crypto";
import { findMuxAssetByPassthrough, listReadyMuxAssets } from "@/lib/mux";

const PLAYBACK_TOKEN_TTL_SEC = 3600; // preview links live for an hour

const b64url = (s: string) => Buffer.from(s).toString("base64url");

/**
 * Mint a signed playback token (RS256 JWT) for a playback id. `aud` selects
 * what the token unlocks: `"v"` = video stream, `"t"` = thumbnail image.
 * Returns null when the signing key env is not configured — callers treat
 * that as "no playable URL" rather than an error.
 */
export function signMuxPlaybackToken(
  playbackId: string,
  aud: "v" | "t" = "v",
  ttlSec = PLAYBACK_TOKEN_TTL_SEC,
): string | null {
  const keyId = process.env.MUX_SIGNING_KEY_ID;
  const keyMaterial = process.env.MUX_SIGNING_PRIVATE_KEY;
  if (!keyId || !keyMaterial) return null;

  // Mux hands the private key back base64-encoded; accept raw PEM too.
  const pem = keyMaterial.includes("-----BEGIN")
    ? keyMaterial
    : Buffer.from(keyMaterial, "base64").toString("utf8");

  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: keyId }));
  const payload = b64url(
    JSON.stringify({ sub: playbackId, aud, exp: Math.floor(Date.now() / 1000) + ttlSec }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(createPrivateKey(pem)).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/** The signed HLS URL for a playback id, or null when signing isn't configured. */
export function muxSignedStreamUrl(playbackId: string): string | null {
  const token = signMuxPlaybackToken(playbackId, "v");
  return token ? `https://stream.mux.com/${playbackId}.m3u8?token=${token}` : null;
}

/** A signed Mux-generated frame for list thumbnails, or null when signing is off. */
export function muxSignedThumbnailUrl(playbackId: string): string | null {
  const token = signMuxPlaybackToken(playbackId, "t");
  return token ? `https://image.mux.com/${playbackId}/thumbnail.jpg?token=${token}` : null;
}

// Minimal supabase-js surface for the guarded reconcile UPDATE (testable fake).
export interface PlaybackDb {
  from(table: string): {
    update(values: Record<string, unknown>): {
      eq(column: string, value: string): {
        is(column: string, value: null): PromiseLike<{ error: { message: string } | null }>;
      };
    };
  };
}

export type ResolvedPlayback = { playbackId: string | null; playbackUrl: string | null };

/**
 * Resolve a video post to a playable signed URL.
 * 1. Use `post.mux_playback_id` when the webhook already reconciled it.
 * 2. Otherwise look the asset up on Mux by passthrough and persist it
 *    (guarded: only where `mux_playback_id` is still NULL).
 * 3. Sign the stream URL; null when the asset isn't ready or signing is off.
 */
export async function resolveVideoPlayback(
  db: PlaybackDb,
  post: { id: string; mux_playback_id: string | null },
): Promise<ResolvedPlayback> {
  let playbackId = post.mux_playback_id;

  if (!playbackId) {
    const asset = await findMuxAssetByPassthrough(post.id).catch(() => null);
    if (asset) {
      playbackId = asset.playbackId;
      await db
        .from("post")
        .update({ mux_asset_id: asset.assetId, mux_playback_id: asset.playbackId })
        .eq("id", post.id)
        .is("mux_playback_id", null);
    }
  }

  if (!playbackId) return { playbackId: null, playbackUrl: null };
  return { playbackId, playbackUrl: muxSignedStreamUrl(playbackId) };
}

/** A `post_video` row as the reconcile needs it (ids never leave the BFF). */
export type ReconcileVideoRow = {
  id: string;
  status: string;
  mux_playback_id: string | null;
  mux_upload_id: string | null;
  /** ISO timestamp; the legacy fallback only considers rows older than this window. */
  created_at?: string | null;
};

/**
 * A row minted by MV-A1 carries a NULL `mux_upload_id` for the few seconds
 * between its insert and the upload-id write. A backfilled legacy row carries
 * the POST's `created_at`, which is always old. So the legacy fallback only
 * trusts a null-upload-id row older than this (ENG-1598 re-review).
 */
export const LEGACY_FALLBACK_MIN_AGE_MS = 10 * 60_000;

/** The guarded write the reconcile needs; `.select("id")` says whether a row actually changed. */
export interface PostVideoWriteDb {
  from(table: string): {
    update(values: Record<string, unknown>): {
      eq(column: string, value: string): {
        is(column: string, value: null): {
          select(columns: string): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
        };
      };
    };
  };
}

/** What the reconcile WROTE for a row: it is now `ready` with this playback id. */
export type ReconciledVideo = { playbackId: string };

/**
 * ENG-1598 review (must-fix 1 + 2) — reconcile a post's `post_video` rows
 * against Mux when the be `mux-webhook` has not delivered (local dev, webhook
 * lag). ONE asset listing for the whole post, matched against every row.
 *
 * - A row matches the ready asset whose passthrough is its own id (ENG-1597).
 * - A **backfilled legacy** row (the migration copies no `mux_upload_id`; every
 *   MV-A1-minted row carries one) whose own-id lookup misses falls back to
 *   passthrough = `post.id` — the legacy upload's passthrough. Without this the
 *   legacy asset was only ever written to `post`, the row stayed NULL, and the
 *   next `post_video` write mirrored that NULL back over `post`, erasing the
 *   video.
 *
 * A match is written to the ROW, never to `post` (the deferred SECURITY
 * DEFINER mirror carries slot 0 onto `post`), with the webhook's own
 * only-if-null guard so the two writers can never fight. The admin client is
 * AAL2 and allowed by `post_video_all_admin`. Returns the rows it wrote; a
 * failed write or a Mux outage just leaves that row unreconciled.
 */
export async function reconcilePostVideos(
  db: PostVideoWriteDb,
  postId: string,
  rows: readonly ReconcileVideoRow[],
  now: number = Date.now(),
): Promise<Map<string, ReconciledVideo>> {
  const out = new Map<string, ReconciledVideo>();
  const pending = rows.filter((r) => !r.mux_playback_id && r.status !== "errored");
  if (pending.length === 0) return out;

  const assets = await listReadyMuxAssets().catch(() => null);
  if (!assets) return out;

  // Never hand one asset to two rows (post_video.mux_asset_id is unique anyway).
  const used = new Set<string>();
  let legacyClaimed = false;
  for (const r of pending) {
    let asset = assets.find((a) => a.passthrough === r.id && !used.has(a.assetId));
    const oldEnough =
      !!r.created_at && now - Date.parse(r.created_at) >= LEGACY_FALLBACK_MIN_AGE_MS;
    if (!asset && r.mux_upload_id === null && oldEnough && !legacyClaimed) {
      asset = assets.find((a) => a.passthrough === postId && !used.has(a.assetId));
      if (asset) legacyClaimed = true;
    }
    if (!asset) continue;
    used.add(asset.assetId);

    const values: Record<string, unknown> = {
      mux_asset_id: asset.assetId,
      mux_playback_id: asset.playbackId,
      status: "ready",
    };
    if (asset.aspectRatio !== null) values.aspect_ratio = asset.aspectRatio;
    const { data, error } = await db
      .from("post_video")
      .update(values)
      .eq("id", r.id)
      .is("mux_playback_id", null)
      .select("id");
    if (error) {
      console.error("post_video reconcile_failed");
      continue;
    }
    // 0 rows = the webhook won the race or RLS refused: do not claim "ready";
    // the next read shows whatever the row really holds.
    if (!data || data.length === 0) continue;
    out.set(r.id, { playbackId: asset.playbackId });
  }
  return out;
}
