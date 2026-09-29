import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

const muxSignedStreamUrl = vi.fn((id: string) => `https://stream.mux.com/${id}.m3u8?token=tok`);
const muxSignedThumbnailUrl = vi.fn((id: string) => `https://image.mux.com/${id}/thumbnail.jpg?token=tok`);
type ReconcileRow = {
  id: string;
  status: string;
  mux_playback_id: string | null;
  mux_upload_id: string | null;
  created_at?: string | null;
};
const reconcilePostVideos =
  vi.fn<(db: unknown, postId: string, rows: ReconcileRow[]) => Promise<Map<string, { playbackId: string }>>>();
vi.mock("@/lib/mux-playback", () => ({
  muxSignedStreamUrl: (id: string) => muxSignedStreamUrl(id),
  muxSignedThumbnailUrl: (id: string) => muxSignedThumbnailUrl(id),
  reconcilePostVideos: (db: unknown, postId: string, rows: ReconcileRow[]) =>
    reconcilePostVideos(db, postId, rows),
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

import {
  claimReconcileSlot,
  RECONCILE_MIN_INTERVAL_MS,
  readPostVideoStatus,
  resetReconcileThrottle,
} from "./video-status";

const P1 = "11111111-1111-1111-1111-111111111111";

function seed(rows: unknown[]) {
  state.tables.post_video = { select: { rows } };
}

beforeEach(() => {
  Object.assign(state, blankState());
  muxSignedStreamUrl.mockClear();
  muxSignedThumbnailUrl.mockClear();
  reconcilePostVideos.mockReset();
  reconcilePostVideos.mockResolvedValue(new Map());
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

  it("reconcile=false (default) never calls reconcilePostVideos, even with no stored playback id", async () => {
    seed([{ id: "pv0", sort_order: 0, status: "uploading", mux_playback_id: null, poster_url: null }]);
    const r = await readPostVideoStatus(makeFakeClient(state) as never, P1);
    if (!("videos" in r)) throw new Error("expected videos");
    expect(r.videos[0].playbackUrl).toBeNull();
    expect(reconcilePostVideos).not.toHaveBeenCalled();
  });

  it("reconcile=true calls reconcilePostVideos once with (sb, postId, rows including mux_upload_id and created_at)", async () => {
    const sb = makeFakeClient(state) as never;
    seed([
      {
        id: "pv0",
        sort_order: 0,
        status: "ready",
        mux_playback_id: "pb_0",
        mux_upload_id: "up_0",
        poster_url: null,
        created_at: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "pv1",
        sort_order: 1,
        status: "uploading",
        mux_playback_id: null,
        mux_upload_id: null,
        poster_url: null,
        created_at: null,
      },
    ]);
    await readPostVideoStatus(sb, P1, { reconcile: true });
    expect(reconcilePostVideos).toHaveBeenCalledTimes(1);
    expect(reconcilePostVideos).toHaveBeenCalledWith(sb, P1, [
      {
        id: "pv0",
        sort_order: 0,
        status: "ready",
        mux_playback_id: "pb_0",
        mux_upload_id: "up_0",
        poster_url: null,
        created_at: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "pv1",
        sort_order: 1,
        status: "uploading",
        mux_playback_id: null,
        mux_upload_id: null,
        poster_url: null,
        created_at: null,
      },
    ]);
  });

  it("a row the reconcile writes reports as ready with a signed playback url", async () => {
    seed([{ id: "pv1", sort_order: 0, status: "uploading", mux_playback_id: null, mux_upload_id: null, poster_url: null }]);
    reconcilePostVideos.mockResolvedValue(new Map([["pv1", { playbackId: "pb_new" }]]));
    const r = await readPostVideoStatus(makeFakeClient(state) as never, P1, { reconcile: true });
    if (!("videos" in r)) throw new Error("expected videos");
    expect(r.videos[0].status).toBe("ready");
    expect(r.videos[0].playbackUrl).toBe("https://stream.mux.com/pb_new.m3u8?token=tok");
    expect(muxSignedStreamUrl).toHaveBeenCalledWith("pb_new");
  });

  it("returned objects never contain mux_upload_id / mux_asset_id / created_at keys", async () => {
    seed([
      {
        id: "pv1",
        sort_order: 0,
        status: "uploading",
        mux_playback_id: null,
        mux_upload_id: "up_1",
        poster_url: null,
        created_at: "2024-01-01T00:00:00.000Z",
      },
    ]);
    reconcilePostVideos.mockResolvedValue(new Map([["pv1", { playbackId: "pb_new" }]]));
    const r = await readPostVideoStatus(makeFakeClient(state) as never, P1, { reconcile: true });
    if (!("videos" in r)) throw new Error("expected videos");
    expect(Object.keys(r.videos[0]).sort()).toEqual(
      ["id", "playbackUrl", "posterUrl", "sortOrder", "status"].sort(),
    );
    expect(JSON.stringify(r.videos)).not.toContain("mux_asset_id");
    expect(JSON.stringify(r.videos)).not.toContain("mux_upload_id");
    expect(JSON.stringify(r.videos)).not.toContain("created_at");
  });
});

describe("claimReconcileSlot / resetReconcileThrottle — ENG-1598 review", () => {
  beforeEach(() => {
    resetReconcileThrottle();
  });

  it("is true the first time for a post", () => {
    expect(claimReconcileSlot("p1", 1000)).toBe(true);
  });

  it("is false again within 30s of the claimed slot", () => {
    expect(claimReconcileSlot("p1", 1000)).toBe(true);
    expect(claimReconcileSlot("p1", 1000 + RECONCILE_MIN_INTERVAL_MS - 1)).toBe(false);
  });

  it("is true again at/after 30s", () => {
    expect(claimReconcileSlot("p1", 1000)).toBe(true);
    expect(claimReconcileSlot("p1", 1000 + RECONCILE_MIN_INTERVAL_MS)).toBe(true);
  });

  it("is tracked independently per post", () => {
    expect(claimReconcileSlot("p1", 1000)).toBe(true);
    expect(claimReconcileSlot("p2", 1000)).toBe(true);
    expect(claimReconcileSlot("p1", 1010)).toBe(false);
    expect(claimReconcileSlot("p2", 1010)).toBe(false);
  });

  it("resetReconcileThrottle forgets every claimed slot", () => {
    expect(claimReconcileSlot("p1", 1000)).toBe(true);
    expect(claimReconcileSlot("p1", 1010)).toBe(false);
    resetReconcileThrottle();
    expect(claimReconcileSlot("p1", 1020)).toBe(true);
  });
});
