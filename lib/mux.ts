// Mux direct-upload creation.
//
// A **direct upload** hands the browser a one-time URL it PUTs the finished
// video straight to — the file bytes never transit our server (guardrail §5:
// "card/media never through our server for the file bytes"). We call the Mux
// REST API directly (no SDK dependency); credentials come from env (guardrail
// §8). Playback policy is `signed` so video is only ever served through
// short-lived signed URLs (subscription gate), never public. No watermark
// mutation — the stablepass mark is a display-time overlay, not baked in.

const MUX_UPLOADS_URL = "https://api.mux.com/video/v1/uploads";
const MUX_ASSETS_URL = "https://api.mux.com/video/v1/assets";

/**
 * Every Mux call is bounded (ENG-1597 review). Cleanup runs AFTER the DB change
 * has committed, so a hung Mux request would otherwise hold the admin request
 * until the function's max duration and report a failure for a change that
 * already happened. A timeout surfaces as a thrown `MuxError`, which every
 * caller already maps (502 on create, logged + swallowed on cleanup).
 */
export const MUX_TIMEOUT_MS = 8000;
const muxSignal = () => AbortSignal.timeout(MUX_TIMEOUT_MS);

export type MuxDirectUpload = { uploadId: string; uploadUrl: string };
export type MuxReadyAsset = { assetId: string; playbackId: string };

/** Thrown for any failure creating the Mux upload → the route maps it to 502 `mux_unavailable`. */
export class MuxError extends Error {}

function muxAuthHeader(): string {
  const tokenId = process.env.MUX_TOKEN_ID;
  const tokenSecret = process.env.MUX_TOKEN_SECRET;
  if (!tokenId || !tokenSecret) throw new MuxError("Mux credentials are not configured.");
  return `Basic ${Buffer.from(`${tokenId}:${tokenSecret}`).toString("base64")}`;
}

export async function createMuxDirectUpload(opts?: {
  corsOrigin?: string;
  /** Echoed back on asset lifecycle webhooks — set to the `post_video` row id
   * (ENG-1597: one row per video slot, 1..5 per post) so the BE `mux-webhook`
   * function can reconcile the processed asset onto the right row. */
  passthrough?: string;
}): Promise<MuxDirectUpload> {
  const auth = muxAuthHeader();

  let res: Response;
  try {
    res = await fetch(MUX_UPLOADS_URL, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      signal: muxSignal(),
      body: JSON.stringify({
        cors_origin: opts?.corsOrigin ?? "*",
        new_asset_settings: {
          playback_policy: ["signed"],
          ...(opts?.passthrough ? { passthrough: opts.passthrough } : {}),
        },
      }),
    });
  } catch (e) {
    throw new MuxError(`Mux request failed: ${(e as Error).message}`);
  }

  if (!res.ok) throw new MuxError(`Mux upload create failed (${res.status}).`);

  const json = (await res.json().catch(() => null)) as { data?: { id?: string; url?: string } } | null;
  const upload = json?.data;
  if (!upload?.id || !upload?.url) throw new MuxError("Mux response missing upload id/url.");
  return { uploadId: upload.id, uploadUrl: upload.url };
}

type MuxAssetRow = {
  id?: string;
  status?: string;
  passthrough?: string;
  playback_ids?: Array<{ id?: string }>;
  /** Mux sends a ratio STRING ("16:9"); parsed by `parseMuxAspectRatio`. */
  aspect_ratio?: unknown;
};

/** A ready asset from the recent-assets listing, keyed by its passthrough. */
export type MuxListedAsset = MuxReadyAsset & { passthrough: string; aspectRatio: number | null };

/**
 * "16:9" → 1.777…; anything malformed / non-positive → null. Same rule as the
 * be `mux-webhook` (post_video.aspect_ratio is `numeric` with a `> 0` check).
 */
export function parseMuxAspectRatio(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(raw);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  const r = w / h;
  return Number.isFinite(r) && r > 0 ? r : null;
}

/**
 * ONE listing of the most recent page of Mux assets, keeping only the READY
 * ones that carry a passthrough + playback id. The webhook (BE `mux-webhook`)
 * is the primary reconciler; this is the read-time fallback for environments
 * where it isn't configured (local dev) or hasn't delivered yet. Uploads we
 * care about are always recent. Callers reconciling several videos call this
 * once and match every row against it (ENG-1598 review) instead of listing
 * per row.
 */
export async function listReadyMuxAssets(): Promise<MuxListedAsset[]> {
  const auth = muxAuthHeader();

  let res: Response;
  try {
    res = await fetch(`${MUX_ASSETS_URL}?limit=100`, {
      headers: { Authorization: auth },
      signal: muxSignal(),
    });
  } catch (e) {
    throw new MuxError(`Mux request failed: ${(e as Error).message}`);
  }
  if (!res.ok) throw new MuxError(`Mux asset list failed (${res.status}).`);

  const json = (await res.json().catch(() => null)) as { data?: MuxAssetRow[] } | null;
  const out: MuxListedAsset[] = [];
  for (const a of json?.data ?? []) {
    const playbackId = a.playback_ids?.[0]?.id;
    if (a.status !== "ready" || !a.id || !playbackId || typeof a.passthrough !== "string") continue;
    out.push({
      assetId: a.id,
      playbackId,
      passthrough: a.passthrough,
      aspectRatio: parseMuxAspectRatio(a.aspect_ratio),
    });
  }
  return out;
}

/** Find a **ready** Mux asset whose `passthrough` equals the given id (post or post_video). */
export async function findMuxAssetByPassthrough(passthrough: string): Promise<MuxReadyAsset | null> {
  const asset = (await listReadyMuxAssets()).find((a) => a.passthrough === passthrough);
  return asset ? { assetId: asset.assetId, playbackId: asset.playbackId } : null;
}

const MUX_UPLOAD_ID_URL = (uploadId: string) => `${MUX_UPLOADS_URL}/${encodeURIComponent(uploadId)}`;
const MUX_ASSET_ID_URL = (assetId: string) => `${MUX_ASSETS_URL}/${encodeURIComponent(assetId)}`;

/**
 * Delete a Mux asset outright (ENG-1597 — a video slot removed from a post, or
 * the whole post rolled back). 2xx or 404 (already gone) both count as
 * success; anything else throws so the caller can decide whether to retry.
 */
export async function deleteMuxAsset(assetId: string): Promise<void> {
  const auth = muxAuthHeader();
  let res: Response;
  try {
    res = await fetch(MUX_ASSET_ID_URL(assetId), {
      method: "DELETE",
      headers: { Authorization: auth },
      signal: muxSignal(),
    });
  } catch (e) {
    throw new MuxError(`Mux request failed: ${(e as Error).message}`);
  }
  if (!res.ok && res.status !== 404) throw new MuxError(`Mux asset delete failed (${res.status}).`);
}

/**
 * Cancel a Mux direct upload that never finished (the slot's row is being
 * removed, or the whole mint is being rolled back, before any bytes landed).
 * 2xx or 404 both count as success.
 */
export async function cancelMuxUpload(uploadId: string): Promise<void> {
  const auth = muxAuthHeader();
  let res: Response;
  try {
    res = await fetch(`${MUX_UPLOAD_ID_URL(uploadId)}/cancel`, {
      method: "PUT",
      headers: { Authorization: auth },
      signal: muxSignal(),
    });
  } catch (e) {
    throw new MuxError(`Mux request failed: ${(e as Error).message}`);
  }
  if (!res.ok && res.status !== 404) throw new MuxError(`Mux upload cancel failed (${res.status}).`);
}

/**
 * The asset id a direct upload has produced, if any — used when `cancel`
 * itself fails (ENG-1597): by then the upload may already have turned into an
 * asset, and cancelling is a no-op we cannot trust, so we look up what it
 * became and delete THAT instead.
 */
export async function getMuxUploadAssetId(uploadId: string): Promise<string | null> {
  const auth = muxAuthHeader();
  let res: Response;
  try {
    res = await fetch(MUX_UPLOAD_ID_URL(uploadId), {
      headers: { Authorization: auth },
      signal: muxSignal(),
    });
  } catch (e) {
    throw new MuxError(`Mux request failed: ${(e as Error).message}`);
  }
  if (!res.ok) throw new MuxError(`Mux upload read failed (${res.status}).`);
  const json = (await res.json().catch(() => null)) as { data?: { asset_id?: string } } | null;
  return json?.data?.asset_id ?? null;
}

/**
 * Best-effort Mux cleanup for one `post_video` slot (ENG-1597). NEVER throws —
 * every caller (the mint rollback, a slot removal, a draft/post hard delete)
 * must still complete its own transaction whether or not Mux cooperates, so a
 * failure here is logged and swallowed rather than propagated.
 *
 * An asset id (the slot finished processing) wins over an upload id: the
 * asset is the thing actually costing storage/bandwidth. Upload-only: cancel
 * it; if the cancel itself fails, the upload may have already turned into an
 * asset between our read and this call, so look that asset up and delete it —
 * only falling back to rethrowing (and logging) the original cancel failure
 * when no asset shows up either. Neither id present is a no-op: nothing was
 * ever minted for this slot, so there is nothing to reach out to Mux for.
 */
export async function cleanupMuxVideo(v: {
  videoId: string;
  assetId?: string | null;
  uploadId?: string | null;
}): Promise<void> {
  try {
    if (v.assetId) {
      await deleteMuxAsset(v.assetId);
      return;
    }
    if (v.uploadId) {
      try {
        await cancelMuxUpload(v.uploadId);
      } catch (cancelErr) {
        let assetId: string | null = null;
        try {
          assetId = await getMuxUploadAssetId(v.uploadId);
        } catch {
          assetId = null;
        }
        if (assetId) {
          await deleteMuxAsset(assetId);
          return;
        }
        throw cancelErr;
      }
      return;
    }
    // Neither id — nothing was ever minted for this slot. No fetch.
  } catch (e) {
    // Never log the auth header — only the videoId and the error message.
    console.error("mux_cleanup_failed", { videoId: v.videoId, error: (e as Error).message });
  }
}
