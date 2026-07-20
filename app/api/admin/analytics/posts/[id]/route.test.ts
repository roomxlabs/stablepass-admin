import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

import { GET } from "./route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
const ctx = () => ({ params: Promise.resolve({ id: "p1" }) });

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("GET /api/admin/analytics/posts/:id", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await GET(new Request("http://localhost/api/admin/analytics/posts/p1"), ctx());
    expect(r.status).toBe(403);
  });

  it("401s with no session", async () => {
    const r = await GET(new Request("http://localhost/api/admin/analytics/posts/p1"), ctx());
    expect(r.status).toBe(401);
  });

  it("404s for an unknown post id", async () => {
    asAdmin();
    state.tables.post = { select: { single: null } };
    const r = await GET(new Request("http://localhost/api/admin/analytics/posts/p1"), ctx());
    expect(r.status).toBe(404);
    const j = await r.json();
    expect(j.error.code).toBe("not_found");
  });

  it("returns post analytics for an admin", async () => {
    asAdmin();
    state.tables.post = {
      select: {
        single: {
          id: "p1",
          title: "Big win",
          type: "update",
          published_at: "2026-07-10T00:00:00.000Z",
          horse_id: "h1",
          horse: { display_name: "Winx Filly", racing_name: "WINX (AUS)" },
          trainer: { name: "C Waller", display_name: "Chris Waller" },
        },
      },
    };
    state.rpcs.admin_post_opens_by_day = { data: [{ day: "2026-07-11", opens: 5 }, { day: "2026-07-12", opens: 3 }] };
    state.rpcs.admin_post_reactions = { data: [{ emoji: "🔥", count: 2 }] };
    state.tables.bookmark = { select: { count: 7 } };
    // reach is per-post: count of `follow` rows targeting this post's horse,
    // not a global trial|active subscription count (which would be identical
    // for every post regardless of horse).
    state.tables.follow = { select: { count: 42 } };
    state.tables.subscription = { select: { count: 100 } };

    const r = await GET(new Request("http://localhost/api/admin/analytics/posts/p1"), ctx());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.post).toEqual({
      id: "p1",
      title: "Big win",
      horseName: "WINX (AUS)",
      trainerName: "Chris Waller",
      type: "update",
      publishedAt: "2026-07-10T00:00:00.000Z",
    });
    expect(j.data.opensByDay).toEqual([
      { day: "2026-07-11", opens: 5 },
      { day: "2026-07-12", opens: 3 },
    ]);
    expect(j.data.reactionsByEmoji).toEqual([{ emoji: "🔥", count: 2 }]);
    expect(j.data.saves).toBe(7);
    expect(j.data.opens).toBe(8);
    expect(j.data.reach).toBe(42);
  });

  it("reach is 0 for a post with no horse_id (no follow query issued)", async () => {
    asAdmin();
    state.tables.post = {
      select: {
        single: {
          id: "p2",
          title: "No horse",
          type: "update",
          published_at: null,
          horse_id: null,
          horse: null,
          trainer: { name: "C Waller", display_name: "Chris Waller" },
        },
      },
    };
    state.rpcs.admin_post_opens_by_day = { data: [] };
    state.rpcs.admin_post_reactions = { data: [] };
    state.tables.bookmark = { select: { count: 0 } };
    state.tables.follow = { select: { count: 999 } }; // must be ignored: no horse_id

    const r = await GET(new Request("http://localhost/api/admin/analytics/posts/p2"), ctx());
    const j = await r.json();
    expect(j.data.reach).toBe(0);
    expect(state.calls.from).not.toContain("follow");
  });

  it("500s with a generic message when the post read errors (no schema/SQL leakage)", async () => {
    asAdmin();
    state.tables.post = { select: { error: { message: 'relation "post" does not exist' } } };
    const r = await GET(new Request("http://localhost/api/admin/analytics/posts/p1"), ctx());
    expect(r.status).toBe(500);
    const j = await r.json();
    expect(j.error.code).toBe("query_failed");
    expect(JSON.stringify(j)).not.toMatch(/relation|does not exist/);
  });
});
