import { describe, it, expect, beforeEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));
const findMuxAssetByPassthrough = vi.fn(async () => null as { assetId: string; playbackId: string } | null);
vi.mock("@/lib/mux", () => ({
  findMuxAssetByPassthrough: () => findMuxAssetByPassthrough(),
}));

import { GET } from "./route";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.MUX_SIGNING_KEY_ID = "sk_test";
process.env.MUX_SIGNING_PRIVATE_KEY = Buffer.from(
  privateKey.export({ type: "pkcs1", format: "pem" }),
).toString("base64");

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
const req = () => new Request("http://t/api/admin/posts/p1/preview");
const params = { params: Promise.resolve({ id: "p1" }) };

beforeEach(() => {
  Object.assign(state, blankState());
  findMuxAssetByPassthrough.mockReset();
  findMuxAssetByPassthrough.mockResolvedValue(null);
});

describe("GET /api/admin/posts/:id/preview", () => {
  it("403s for a non-admin (guardrail)", async () => {
    state.user = { id: "u1" };
    state.tables.app_user = { select: { single: { is_admin: false } } };
    const r = await GET(req(), params);
    expect(r.status).toBe(403);
  });

  it("404s when the post does not exist", async () => {
    asAdmin();
    state.tables.post = { select: { single: null } };
    const r = await GET(req(), params);
    expect(r.status).toBe(404);
  });

  it("video with a reconciled playback id → frames carry a signed HLS playbackUrl", async () => {
    asAdmin();
    state.tables.post = {
      select: { single: { id: "p1", type: "video", status: "published", mux_playback_id: "pb_1" } },
    };
    const r = await GET(req(), params);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.mobile.muxPlaybackId).toBe("pb_1");
    expect(j.data.mobile.playbackUrl).toContain("https://stream.mux.com/pb_1.m3u8?token=");
    expect(j.data.web.playbackUrl).toBe(j.data.mobile.playbackUrl);
  });

  it("video without a playback id falls back to the Mux passthrough lookup", async () => {
    asAdmin();
    findMuxAssetByPassthrough.mockResolvedValue({ assetId: "as_1", playbackId: "pb_2" });
    state.tables.post = {
      select: { single: { id: "p1", type: "video", status: "draft", mux_playback_id: null } },
      mutate: {}, // the guarded reconcile UPDATE
    };
    const r = await GET(req(), params);
    const j = await r.json();
    expect(j.data.mobile.muxPlaybackId).toBe("pb_2");
    expect(j.data.mobile.playbackUrl).toContain("pb_2.m3u8?token=");
  });

  it("photo posts carry no playbackUrl", async () => {
    asAdmin();
    state.tables.post = {
      select: { single: { id: "p1", type: "photo", status: "published", media_url: "p1/original" } },
    };
    const r = await GET(req(), params);
    const j = await r.json();
    expect(j.data.mobile.playbackUrl).toBeNull();
  });
});
