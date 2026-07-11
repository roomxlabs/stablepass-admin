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

export type MuxDirectUpload = { uploadId: string; uploadUrl: string };

/** Thrown for any failure creating the Mux upload → the route maps it to 502 `mux_unavailable`. */
export class MuxError extends Error {}

export async function createMuxDirectUpload(opts?: { corsOrigin?: string }): Promise<MuxDirectUpload> {
  const tokenId = process.env.MUX_TOKEN_ID;
  const tokenSecret = process.env.MUX_TOKEN_SECRET;
  if (!tokenId || !tokenSecret) throw new MuxError("Mux credentials are not configured.");

  const auth = Buffer.from(`${tokenId}:${tokenSecret}`).toString("base64");

  let res: Response;
  try {
    res = await fetch(MUX_UPLOADS_URL, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        cors_origin: opts?.corsOrigin ?? "*",
        new_asset_settings: { playback_policy: ["signed"] },
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
