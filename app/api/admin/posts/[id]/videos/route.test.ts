import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

import { GET } from "./route";

const P1 = "11111111-1111-1111-1111-111111111111";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const getReq = () => new Request("http://t");

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("GET /api/admin/posts/:id/videos — ENG-1598", () => {
  it("401s with no session", async () => {
    const r = await GET(getReq(), ctx(P1));
    expect(r.status).toBe(401);
  });

  it("403s for a non-admin", async () => {
    asNonAdmin();
    const r = await GET(getReq(), ctx(P1));
    expect(r.status).toBe(403);
  });

  it("404 not_found for a non-uuid id", async () => {
    asAdmin();
    const r = await GET(getReq(), ctx("not-a-uuid"));
    expect(r.status).toBe(404);
    const j = await r.json();
    expect(j.error.code).toBe("not_found");
  });

  it("200 with the post's videos", async () => {
    asAdmin();
    state.tables.post_video = {
      select: {
        rows: [
          { id: "pv0", sort_order: 0, status: "ready", mux_playback_id: null, poster_url: null },
          { id: "pv1", sort_order: 1, status: "uploading", mux_playback_id: null, poster_url: null },
        ],
      },
    };
    const r = await GET(getReq(), ctx(P1));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.videos).toEqual([
      { id: "pv0", sortOrder: 0, status: "ready", posterUrl: null, playbackUrl: null },
      { id: "pv1", sortOrder: 1, status: "uploading", posterUrl: null, playbackUrl: null },
    ]);
  });

  it("503 videos_unavailable when post_video is missing (PGRST205)", async () => {
    asAdmin();
    state.tables.post_video = { select: { error: { code: "PGRST205" } } };
    const r = await GET(getReq(), ctx(P1));
    expect(r.status).toBe(503);
    const j = await r.json();
    expect(j.error.code).toBe("videos_unavailable");
  });

  it("400 query_failed on any other error", async () => {
    asAdmin();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    state.tables.post_video = { select: { error: { code: "42501" } } };
    const r = await GET(getReq(), ctx(P1));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("query_failed");
    spy.mockRestore();
  });
});
