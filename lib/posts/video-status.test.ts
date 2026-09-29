import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

const muxSignedStreamUrl = vi.fn((id: string) => `https://stream.mux.com/${id}.m3u8?token=tok`);
const muxSignedThumbnailUrl = vi.fn((id: string) => `https://image.mux.com/${id}/thumbnail.jpg?token=tok`);
const resolvePostVideoPlayback = vi.fn(async (v: { id: string; mux_playback_id: string | null }) => ({
  playbackId: `resolved_${v.id}`,
  playbackUrl: `https://stream.mux.com/resolved_${v.id}.m3u8?token=tok`,
}));
vi.mock("@/lib/mux-playback", () => ({
  muxSignedStreamUrl: (id: string) => muxSignedStreamUrl(id),
  muxSignedThumbnailUrl: (id: string) => muxSignedThumbnailUrl(id),
  resolvePostVideoPlayback: (v: { id: string; mux_playback_id: string | null }) => resolvePostVideoPlayback(v),
}));

// Bespoke signPhotoMap so a poster path can be made to "fail to sign" (a
// path with no entry in the returned map) — the real one always succeeds
// against the shared fake client.
const signPhotoMap = vi.fn(async (_sb: unknown, _bucket: string, values: (string | null | undefined)[]) => {
  const out = new Map<string, string>();
  for (const v of values) {
    if (v && v !== "posters/broken.jpg") out.set(v, `https://storage.local/post-media/${v}`);
  }
  return out;
});
vi.mock("@/lib/storage/photos", () => ({
  POST_MEDIA_BUCKET: "post-media",
  signPhotoMap: (sb: unknown, bucket: string, values: (string | null | undefined)[]) =>
    signPhotoMap(sb, bucket, values),
}));

import { readPostVideoStatus } from "./video-status";

const P1 = "11111111-1111-1111-1111-111111111111";

function seed(rows: unknown[]) {
  state.tables.post_video = { select: { rows } };
}

beforeEach(() => {
  Object.assign(state, blankState());
  muxSignedStreamUrl.mockClear();
  muxSignedThumbnailUrl.mockClear();
  resolvePostVideoPlayback.mockClear();
  signPhotoMap.mockClear();
});

describe("readPostVideoStatus — ENG-1598", () => {
  it("happy path: signs a stored poster, signs the playback url, and reads via the query's order", async () => {
    seed([
      { id: "pv0", sort_order: 0, status: "ready", mux_playback_id: "pb_0", poster_url: "posters/pv0.jpg" },
      { id: "pv1", sort_order: 1, status: "ready", mux_playback_id: "pb_1", poster_url: null },
    ]);
    const r = await readPostVideoStatus(makeFakeClient(state) as never, P1);
    if (!("videos" in r)) throw new Error("expected videos");
    expect(r.videos).toEqual([
      {
        id: "pv0",
        sortOrder: 0,
        status: "ready",
        posterUrl: "https://storage.local/post-media/posters/pv0.jpg",
        playbackUrl: "https://stream.mux.com/pb_0.m3u8?token=tok",
      },
      {
        id: "pv1",
        sortOrder: 1,
        status: "ready",
        // no stored poster + ready + has a playback id → Mux thumbnail fallback.
        posterUrl: "https://image.mux.com/pb_1/thumbnail.jpg?token=tok",
        playbackUrl: "https://stream.mux.com/pb_1.m3u8?token=tok",
      },
    ]);
    expect(state.calls.modifiers).toContainEqual({
      table: "post_video",
      kind: "order",
      args: ["sort_order", undefined],
    });
  });

  it("a status value other than ready/errored passes through as uploading", async () => {
    seed([{ id: "pv0", sort_order: 0, status: "processing", mux_playback_id: null, poster_url: null }]);
    const r = await readPostVideoStatus(makeFakeClient(state) as never, P1);
    if (!("videos" in r)) throw new Error("expected videos");
    expect(r.videos[0].status).toBe("uploading");
  });

  it("no poster, not ready → no thumbnail fallback, posterUrl null", async () => {
    seed([{ id: "pv0", sort_order: 0, status: "uploading", mux_playback_id: "pb_0", poster_url: null }]);
    const r = await readPostVideoStatus(makeFakeClient(state) as never, P1);
    if (!("videos" in r)) throw new Error("expected videos");
    expect(r.videos[0].posterUrl).toBeNull();
  });

  it("a poster that fails to sign falls back to the Mux thumbnail (ready + playback id)", async () => {
    seed([
      { id: "pv0", sort_order: 0, status: "ready", mux_playback_id: "pb_0", poster_url: "posters/broken.jpg" },
    ]);
    const r = await readPostVideoStatus(makeFakeClient(state) as never, P1);
    if (!("videos" in r)) throw new Error("expected videos");
    expect(r.videos[0].posterUrl).toBe("https://image.mux.com/pb_0/thumbnail.jpg?token=tok");
  });

  it("missing post_video table (isMissingVideoTable) → unavailable", async () => {
    state.tables.post_video = { select: { error: { code: "PGRST205" } } };
    const r = await readPostVideoStatus(makeFakeClient(state) as never, P1);
    expect(r).toEqual({ unavailable: true });
  });

  it("any other query error → error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    state.tables.post_video = { select: { error: { code: "42501" } } };
    const r = await readPostVideoStatus(makeFakeClient(state) as never, P1);
    expect(r).toEqual({ error: true });
    expect(spy).toHaveBeenCalledWith("post_video query_failed", "42501");
    spy.mockRestore();
  });

  it("result objects carry exactly the five keys — no mux ids leak", async () => {
    seed([{ id: "pv0", sort_order: 0, status: "ready", mux_playback_id: "pb_0", poster_url: null }]);
    const r = await readPostVideoStatus(makeFakeClient(state) as never, P1);
    if (!("videos" in r)) throw new Error("expected videos");
    expect(Object.keys(r.videos[0]).sort()).toEqual(
      ["id", "playbackUrl", "posterUrl", "sortOrder", "status"].sort(),
    );
    expect(JSON.stringify(r.videos)).not.toContain("mux_asset_id");
    expect(JSON.stringify(r.videos)).not.toContain("mux_upload_id");
  });

  it("reconcile=false (default) never calls resolvePostVideoPlayback, even with no stored playback id", async () => {
    seed([{ id: "pv0", sort_order: 0, status: "uploading", mux_playback_id: null, poster_url: null }]);
    const r = await readPostVideoStatus(makeFakeClient(state) as never, P1);
    if (!("videos" in r)) throw new Error("expected videos");
    expect(r.videos[0].playbackUrl).toBeNull();
    expect(resolvePostVideoPlayback).not.toHaveBeenCalled();
  });

  it("reconcile=true calls resolvePostVideoPlayback only for rows missing a playback id", async () => {
    seed([
      { id: "pv0", sort_order: 0, status: "ready", mux_playback_id: "pb_0", poster_url: null },
      { id: "pv1", sort_order: 1, status: "uploading", mux_playback_id: null, poster_url: null },
    ]);
    const r = await readPostVideoStatus(makeFakeClient(state) as never, P1, { reconcile: true });
    if (!("videos" in r)) throw new Error("expected videos");
    expect(resolvePostVideoPlayback).toHaveBeenCalledTimes(1);
    expect(resolvePostVideoPlayback).toHaveBeenCalledWith({ id: "pv1", mux_playback_id: null });
    expect(r.videos[1].playbackUrl).toBe("https://stream.mux.com/resolved_pv1.m3u8?token=tok");
  });
});
