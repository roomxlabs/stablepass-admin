import { describe, it, expect, beforeEach, vi } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { makeFakeClient, blankState } from "@/lib/testing/supabase-fake";

const findMuxAssetByPassthrough = vi.fn<(p: string) => Promise<{ assetId: string; playbackId: string } | null>>();
vi.mock("@/lib/mux", () => ({
  findMuxAssetByPassthrough: (p: string) => findMuxAssetByPassthrough(p),
}));

import {
  muxSignedStreamUrl,
  muxSignedThumbnailUrl,
  resolveVideoPlayback,
  signMuxPlaybackToken,
  type PlaybackDb,
} from "./mux-playback";

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

  it("mints thumbnail tokens with aud=t on the image host", () => {
    const url = muxSignedThumbnailUrl("pb_1");
    expect(url).toContain("https://image.mux.com/pb_1/thumbnail.jpg?token=");
    const payload = JSON.parse(Buffer.from(url!.split("token=")[1].split(".")[1], "base64url").toString());
    expect(payload).toMatchObject({ sub: "pb_1", aud: "t" });
  });

  it("returns null when the signing key env is not configured", () => {
    clearSigningEnv();
    expect(signMuxPlaybackToken("pb_1")).toBeNull();
    expect(muxSignedStreamUrl("pb_1")).toBeNull();
    expect(muxSignedThumbnailUrl("pb_1")).toBeNull();
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

  // ENG-993 — the guard pinned through the SHARED fake, not just the bespoke
  // one above. `app/api/admin/posts/[id]/preview` reaches this same reconcile
  // with the real `supabase-fake` client, where `.is()` used to be a pure
  // no-op: the precondition that stops a concurrent webhook write being
  // clobbered vanished before any assertion could see it. This test reads the
  // recorded filter, so deleting `.is("mux_playback_id", null)` from
  // `resolveVideoPlayback` turns it RED.
  it("records the only-if-null precondition on the shared supabase fake (lost-update guard)", async () => {
    findMuxAssetByPassthrough.mockResolvedValue({ assetId: "as_1", playbackId: "pb_2" });
    const state = blankState();
    const sb = makeFakeClient(state) as unknown as PlaybackDb;

    await resolveVideoPlayback(sb, { id: "post_1", mux_playback_id: null });

    const update = state.calls.mutations.find((m) => m.op === "update" && m.table === "post");
    expect(update).toBeDefined();
    expect(update!.payload).toEqual({ mux_asset_id: "as_1", mux_playback_id: "pb_2" });
    // Both the row selector AND the precondition must be on the chain. The
    // `is` entry is the assertion that fails if the guard is removed.
    expect(update!.filters).toEqual([
      { column: "id", value: "post_1" },
      { column: "mux_playback_id", value: null, op: "is" },
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
