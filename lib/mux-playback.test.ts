import { describe, it, expect, beforeEach, vi } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";

const findMuxAssetByPassthrough = vi.fn<(p: string) => Promise<{ assetId: string; playbackId: string } | null>>();
vi.mock("@/lib/mux", () => ({
  findMuxAssetByPassthrough: (p: string) => findMuxAssetByPassthrough(p),
}));

import { muxSignedStreamUrl, resolveVideoPlayback, signMuxPlaybackToken, type PlaybackDb } from "./mux-playback";

// A real (throwaway) RSA keypair so tokens can be cryptographically verified.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function setSigningEnv() {
  process.env.MUX_SIGNING_KEY_ID = "sk_test";
  process.env.MUX_SIGNING_PRIVATE_KEY = Buffer.from(
    privateKey.export({ type: "pkcs1", format: "pem" }),
  ).toString("base64");
}

function clearSigningEnv() {
  delete process.env.MUX_SIGNING_KEY_ID;
  delete process.env.MUX_SIGNING_PRIVATE_KEY;
}

/** Fake PlaybackDb that records the guarded reconcile UPDATE. */
function makeDb() {
  const calls: { table: string; values: Record<string, unknown>; eq: unknown[]; is: unknown[] }[] = [];
  const db: PlaybackDb = {
    from: (table) => ({
      update: (values) => ({
        eq: (...eq: unknown[]) => ({
          is: (...is: unknown[]) => {
            calls.push({ table, values, eq, is });
            return Promise.resolve({ error: null });
          },
        }),
      }),
    }),
  };
  return { db, calls };
}

beforeEach(() => {
  findMuxAssetByPassthrough.mockReset();
  setSigningEnv();
});

describe("signMuxPlaybackToken", () => {
  it("mints a verifiable RS256 JWT with sub=playbackId and aud=v", () => {
    const token = signMuxPlaybackToken("pb_1");
    expect(token).toBeTruthy();
    const [h, p, sig] = token!.split(".");
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(header).toMatchObject({ alg: "RS256", kid: "sk_test" });
    expect(payload.sub).toBe("pb_1");
    expect(payload.aud).toBe("v");
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    expect(verifier.verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
  });

  it("returns null when the signing key env is not configured", () => {
    clearSigningEnv();
    expect(signMuxPlaybackToken("pb_1")).toBeNull();
    expect(muxSignedStreamUrl("pb_1")).toBeNull();
  });
});

describe("resolveVideoPlayback", () => {
  it("signs directly when the webhook already set mux_playback_id (no Mux call)", async () => {
    const { db, calls } = makeDb();
    const r = await resolveVideoPlayback(db, { id: "post_1", mux_playback_id: "pb_9" });
    expect(r.playbackId).toBe("pb_9");
    expect(r.playbackUrl).toContain("https://stream.mux.com/pb_9.m3u8?token=");
    expect(findMuxAssetByPassthrough).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("reconciles from Mux by passthrough and persists via a guarded only-if-null update", async () => {
    findMuxAssetByPassthrough.mockResolvedValue({ assetId: "as_1", playbackId: "pb_2" });
    const { db, calls } = makeDb();
    const r = await resolveVideoPlayback(db, { id: "post_1", mux_playback_id: null });
    expect(findMuxAssetByPassthrough).toHaveBeenCalledWith("post_1");
    expect(r.playbackId).toBe("pb_2");
    expect(r.playbackUrl).toContain("pb_2.m3u8?token=");
    expect(calls).toEqual([
      {
        table: "post",
        values: { mux_asset_id: "as_1", mux_playback_id: "pb_2" },
        eq: ["id", "post_1"],
        is: ["mux_playback_id", null],
      },
    ]);
  });

  it("returns nulls when the asset is not ready yet (and Mux errors don't throw)", async () => {
    findMuxAssetByPassthrough.mockRejectedValue(new Error("mux down"));
    const { db, calls } = makeDb();
    const r = await resolveVideoPlayback(db, { id: "post_1", mux_playback_id: null });
    expect(r).toEqual({ playbackId: null, playbackUrl: null });
    expect(calls).toHaveLength(0);
  });
});
