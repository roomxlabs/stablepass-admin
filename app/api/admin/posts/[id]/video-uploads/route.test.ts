import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

const createMuxDirectUpload = vi.fn<
  (opts?: { passthrough?: string }) => Promise<{ uploadId: string; uploadUrl: string }>
>(async (opts) => ({ uploadId: `up_${opts?.passthrough}`, uploadUrl: `https://mux.local/${opts?.passthrough}` }));
const cleanupMuxVideo = vi.fn<
  (v: { videoId: string; assetId?: string | null; uploadId?: string | null }) => Promise<void>
>(async () => undefined);
vi.mock("@/lib/mux", () => ({
  MuxError: class MuxError extends Error {},
  createMuxDirectUpload: (opts?: { passthrough?: string }) => createMuxDirectUpload(opts),
  cleanupMuxVideo: (v: { videoId: string; assetId?: string | null; uploadId?: string | null }) =>
    cleanupMuxVideo(v),
}));

import { POST } from "./route";

const P1 = "11111111-1111-1111-1111-111111111111";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const postReq = (body?: unknown) =>
  new Request("http://t", {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

function seedVideoPost(rows: { id: string; sort_order: number; status?: string }[]) {
  state.tables.post = { select: { single: { id: P1, type: "video" } } };
  state.tables.post_video = {
    select: {
      rows: rows.map((r) => ({
        id: r.id,
        sort_order: r.sort_order,
        status: r.status ?? "ready",
        mux_upload_id: null,
        mux_asset_id: null,
      })),
    },
  };
}

beforeEach(() => {
  Object.assign(state, blankState());
  createMuxDirectUpload.mockClear();
  cleanupMuxVideo.mockClear();
});

describe("POST /api/admin/posts/:id/video-uploads — ENG-1597", () => {
  it("401s with no session", async () => {
    const r = await POST(postReq({ count: 1 }), ctx(P1));
    expect(r.status).toBe(401);
  });

  it("403s for a non-admin", async () => {
    asNonAdmin();
    const r = await POST(postReq({ count: 1 }), ctx(P1));
    expect(r.status).toBe(403);
  });

  it("403 mfa_required for an AAL1 admin", async () => {
    asAdmin();
    state.aal = "aal1";
    const r = await POST(postReq({ count: 1 }), ctx(P1));
    expect(r.status).toBe(403);
    const j = await r.json();
    expect(j.error.code).toBe("mfa_required");
  });

  it("404 not_found for an unknown post", async () => {
    asAdmin();
    state.tables.post = { select: { single: null } };
    const r = await POST(postReq({ count: 1 }), ctx(P1));
    expect(r.status).toBe(404);
  });

  it("409 not_video_post for a non-video post", async () => {
    asAdmin();
    state.tables.post = { select: { single: { id: P1, type: "photo" } } };
    const r = await POST(postReq({ count: 1 }), ctx(P1));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("not_video_post");
  });

  it.each([0, 6, -1, 2.5, "3"])("400 invalid_video_count for count = %j", async (count) => {
    asAdmin();
    const r = await POST(postReq({ count }), ctx(P1));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("invalid_video_count");
  });

  it("3 existing + 2 → 201 with 2 uploads at sort_order 3,4", async () => {
    asAdmin();
    seedVideoPost([
      { id: "pv0", sort_order: 0 },
      { id: "pv1", sort_order: 1 },
      { id: "pv2", sort_order: 2 },
    ]);
    state.tables.post_video.mutate = {
      rows: [
        { id: "pv3", sort_order: 3 },
        { id: "pv4", sort_order: 4 },
      ],
    };

    const r = await POST(postReq({ count: 2 }), ctx(P1));
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.data.uploads).toEqual([
      { videoId: "pv3", uploadUrl: "https://mux.local/pv3" },
      { videoId: "pv4", uploadUrl: "https://mux.local/pv4" },
    ]);
    const insertCall = state.calls.mutations.find((m) => m.table === "post_video" && m.op === "insert");
    expect(insertCall?.payload).toEqual([
      { post_id: P1, sort_order: 3, status: "uploading" },
      { post_id: P1, sort_order: 4, status: "uploading" },
    ]);
  });

  it("4 existing + 2 → 409 video_cap, no insert attempted", async () => {
    asAdmin();
    seedVideoPost([
      { id: "pv0", sort_order: 0 },
      { id: "pv1", sort_order: 1 },
      { id: "pv2", sort_order: 2 },
      { id: "pv3", sort_order: 3 },
    ]);
    const r = await POST(postReq({ count: 2 }), ctx(P1));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("video_cap");
    expect(state.calls.mutations.filter((m) => m.op === "insert")).toHaveLength(0);
  });

  it("5 existing + 1 → 409 video_cap", async () => {
    asAdmin();
    seedVideoPost([
      { id: "pv0", sort_order: 0 },
      { id: "pv1", sort_order: 1 },
      { id: "pv2", sort_order: 2 },
      { id: "pv3", sort_order: 3 },
      { id: "pv4", sort_order: 4 },
    ]);
    const r = await POST(postReq({ count: 1 }), ctx(P1));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("video_cap");
  });

  it("23505 on insert → 409 video_set_stale", async () => {
    asAdmin();
    seedVideoPost([{ id: "pv0", sort_order: 0 }]);
    state.tables.post_video.mutate = { error: { code: "23505" } };
    const r = await POST(postReq({ count: 1 }), ctx(P1));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("video_set_stale");
  });

  it("Mux failure → inserted rows deleted, 502 mux_unavailable", async () => {
    asAdmin();
    seedVideoPost([{ id: "pv0", sort_order: 0 }]);
    state.tables.post_video.mutate = {
      rows: [
        { id: "pv1", sort_order: 1 },
        { id: "pv2", sort_order: 2 },
      ],
    };
    createMuxDirectUpload
      .mockResolvedValueOnce({ uploadId: "up_pv1", uploadUrl: "https://mux.local/pv1" })
      .mockRejectedValueOnce(new Error("mux down"));

    const r = await POST(postReq({ count: 2 }), ctx(P1));
    expect(r.status).toBe(502);
    const j = await r.json();
    expect(j.error.code).toBe("mux_unavailable");
    expect(state.calls.mutations).toContainEqual(
      expect.objectContaining({
        table: "post_video",
        op: "delete",
        filters: expect.arrayContaining([
          { column: "id", value: ["pv1", "pv2"], op: "in" },
          { column: "post_id", value: P1 },
        ]),
      }),
    );
  });

  it("response never contains a mux upload id", async () => {
    asAdmin();
    seedVideoPost([]);
    state.tables.post_video.mutate = { rows: [{ id: "pv0", sort_order: 0 }] };
    const r = await POST(postReq({ count: 1 }), ctx(P1));
    const body = await r.text();
    expect(body).not.toContain("mux_upload_id");
    expect(body).not.toContain("muxUploadId");
  });

  it("published post (not just draft) can still append video slots", async () => {
    asAdmin();
    state.tables.post = { select: { single: { id: P1, type: "video", status: "published" } } };
    state.tables.post_video = { select: { rows: [] }, mutate: { rows: [{ id: "pv0", sort_order: 0 }] } };
    const r = await POST(postReq({ count: 1 }), ctx(P1));
    expect(r.status).toBe(201);
  });
});
