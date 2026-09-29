import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

// ENG-1598 review — a spy on the real `readPostVideoStatus` (everything else
// in the module, incl. the real `claimReconcileSlot` throttle, stays genuine)
// so a test can prove WHAT the route passed as `opts.reconcile`, not just that
// the response shape is right.
const readPostVideoStatusSpy = vi.fn();
vi.mock("@/lib/posts/video-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posts/video-status")>();
  return {
    ...actual,
    readPostVideoStatus: (...args: Parameters<typeof actual.readPostVideoStatus>) => {
      readPostVideoStatusSpy(...args);
      return actual.readPostVideoStatus(...args);
    },
  };
});

import { resetReconcileThrottle } from "@/lib/posts/video-status";
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
  readPostVideoStatusSpy.mockClear();
  resetReconcileThrottle();
});

function seedTwoRows() {
  state.tables.post_video = {
    select: {
      rows: [
        { id: "pv0", sort_order: 0, status: "ready", mux_playback_id: "pb_0", poster_url: null },
        { id: "pv1", sort_order: 1, status: "ready", mux_playback_id: "pb_1", poster_url: null },
      ],
    },
  };
}

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

  it("403 mfa_required for an AAL1 admin", async () => {
    asAdmin();
    state.aal = "aal1";
    const r = await GET(getReq(), ctx(P1));
    expect(r.status).toBe(403);
    const j = await r.json();
    expect(j.error.code).toBe("mfa_required");
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

  it("two immediate GETs for the same post pass reconcile true then false (ENG-1598 review)", async () => {
    asAdmin();
    seedTwoRows();
    await GET(getReq(), ctx(P1));
    await GET(getReq(), ctx(P1));
    expect(readPostVideoStatusSpy).toHaveBeenCalledTimes(2);
    const opts = readPostVideoStatusSpy.mock.calls.map((c) => c[2]);
    expect(opts[0]).toEqual({ reconcile: true });
    expect(opts[1]).toEqual({ reconcile: false });
  });
});
