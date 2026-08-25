import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

import { POST } from "./route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const postReq = (body: unknown) =>
  new Request("http://t/api/admin/posts/p1/poster", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("POST /api/admin/posts/:id/poster", () => {
  it("403s for a non-admin (guardrail 1)", async () => {
    asNonAdmin();
    const r = await POST(postReq({ time: 3.5 }), ctx("p1"));
    expect(r.status).toBe(403);
    expect(state.calls.functions).toEqual([]);
  });

  it("validates time → 400", async () => {
    asAdmin();
    for (const time of [-1, "3.5", null, undefined, Number.NaN]) {
      const r = await POST(postReq({ time }), ctx("p1"));
      expect(r.status).toBe(400);
      const j = await r.json();
      expect(j.error.code).toBe("validation_failed");
    }
    expect(state.calls.functions).toEqual([]);
  });

  it("invokes rebake-poster with { postId, time } and returns the new poster", async () => {
    asAdmin();
    state.functions = {
      "rebake-poster": {
        data: { data: { posterUrl: "posters/p1-9.jpg", posterTimeS: 4.25 } },
        error: null,
      },
    };

    const r = await POST(postReq({ time: 4.25 }), ctx("p1"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data).toEqual({
      posterUrl: "posters/p1-9.jpg",
      posterTimeS: 4.25,
      posterDisplayUrl: "https://storage.local/post-media/posters/p1-9.jpg",
    });

    expect(state.calls.functions).toEqual([
      { name: "rebake-poster", body: { postId: "p1", time: 4.25 } },
    ]);
    // Signed for display — path only, never a Mux URL (guardrail 8).
    expect(state.calls.storage).toContainEqual({
      bucket: "post-media",
      path: "posters/p1-9.jpg",
    });
  });

  it("maps a BE failure to an error and does not invent a poster_url", async () => {
    asAdmin();
    state.functions = {
      "rebake-poster": {
        data: { error: { code: "rebake_failed" } },
        error: {
          message: "Edge Function returned a non-2xx status code",
          context: { status: 500 },
        },
      },
    };

    const r = await POST(postReq({ time: 2 }), ctx("p1"));
    expect(r.status).toBe(500);
    const j = await r.json();
    expect(j.error.code).toBe("rebake_failed");
    expect(j.data).toBeUndefined();
    // No Storage sign on failure — old poster stays as-is.
    expect(state.calls.storage).toEqual([]);
  });

  it("maps BE 404 not_found", async () => {
    asAdmin();
    state.functions = {
      "rebake-poster": {
        data: { error: { code: "not_found" } },
        error: {
          message: "Edge Function returned a non-2xx status code",
          context: { status: 404 },
        },
      },
    };
    const r = await POST(postReq({ time: 1 }), ctx("p1"));
    expect(r.status).toBe(404);
    const j = await r.json();
    expect(j.error.code).toBe("not_found");
  });
});
