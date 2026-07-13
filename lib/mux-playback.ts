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
import { findMuxAssetByPassthrough } from "@/lib/mux";

const PLAYBACK_TOKEN_TTL_SEC = 3600; // preview links live for an hour

const b64url = (s: string) => Buffer.from(s).toString("base64url");

/**
 * Mint a signed playback token (RS256 JWT, `aud: "v"`) for a playback id.
 * Returns null when the signing key env is not configured — callers treat
 * that as "no playable URL" rather than an error.
 */
export function signMuxPlaybackToken(playbackId: string, ttlSec = PLAYBACK_TOKEN_TTL_SEC): string | null {
  const keyId = process.env.MUX_SIGNING_KEY_ID;
  const keyMaterial = process.env.MUX_SIGNING_PRIVATE_KEY;
  if (!keyId || !keyMaterial) return null;

  // Mux hands the private key back base64-encoded; accept raw PEM too.
  const pem = keyMaterial.includes("-----BEGIN")
    ? keyMaterial
    : Buffer.from(keyMaterial, "base64").toString("utf8");

  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: keyId }));
  const payload = b64url(
    JSON.stringify({ sub: playbackId, aud: "v", exp: Math.floor(Date.now() / 1000) + ttlSec }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(createPrivateKey(pem)).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/** The signed HLS URL for a playback id, or null when signing isn't configured. */
export function muxSignedStreamUrl(playbackId: string): string | null {
  const token = signMuxPlaybackToken(playbackId);
  return token ? `https://stream.mux.com/${playbackId}.m3u8?token=${token}` : null;
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
