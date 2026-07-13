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
  /** Echoed back on asset lifecycle webhooks — set to the post id so the BE
   * `mux-webhook` function can reconcile the processed asset onto the post. */
  passthrough?: string;
}): Promise<MuxDirectUpload> {
  const auth = muxAuthHeader();

  let res: Response;
  try {
    res = await fetch(MUX_UPLOADS_URL, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
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
};

/**
 * Find a **ready** Mux asset whose `passthrough` equals the given post id.
 * The webhook (BE `mux-webhook`) is the primary reconciler; this is the
 * read-time fallback for environments where it isn't configured (local dev)
 * or hasn't delivered yet. Scans the most recent page of assets — uploads we
 * care about are always recent.
 */
export async function findMuxAssetByPassthrough(passthrough: string): Promise<MuxReadyAsset | null> {
  const auth = muxAuthHeader();

  let res: Response;
  try {
    res = await fetch(`${MUX_ASSETS_URL}?limit=100`, { headers: { Authorization: auth } });
  } catch (e) {
    throw new MuxError(`Mux request failed: ${(e as Error).message}`);
  }
  if (!res.ok) throw new MuxError(`Mux asset list failed (${res.status}).`);

  const json = (await res.json().catch(() => null)) as { data?: MuxAssetRow[] } | null;
  const asset = json?.data?.find((a) => a.passthrough === passthrough && a.status === "ready");
  const playbackId = asset?.playback_ids?.[0]?.id;
  return asset?.id && playbackId ? { assetId: asset.id, playbackId } : null;
}
