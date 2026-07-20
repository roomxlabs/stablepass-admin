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

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("GET /api/admin/analytics/engagement", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await GET(new Request("http://localhost/api/admin/analytics/engagement"));
    expect(r.status).toBe(403);
  });

  it("401s with no session", async () => {
    const r = await GET(new Request("http://localhost/api/admin/analytics/engagement"));
    expect(r.status).toBe(401);
  });

  it("400s for an invalid period", async () => {
    asAdmin();
    const r = await GET(new Request("http://localhost/api/admin/analytics/engagement?period=90d"));
    expect(r.status).toBe(400);
  });

  it("returns trainer/horse/top-post engagement for an admin", async () => {
    asAdmin();
    state.rpcs.admin_trainer_engagement = {
      data: [
        {
          trainer_id: "t1",
          name: "Chris Waller",
          horses: 5,
          posts: 12,
          opens: 300,
          reactions: 40,
          saves: 10,
          website_clicks: 8,
        },
      ],
    };
    state.rpcs.admin_horse_engagement = {
      data: [{ horse_id: "h1", name: "Winx", trainer_name: "Chris Waller", posts: 3, opens: 90, reactions: 12, saves: 4 }],
    };
    state.rpcs.admin_top_posts = {
      data: [{ post_id: "p1", title: "Big win", horse_name: "Winx", type: "update", opens: 90, reactions: 12, saves: 4 }],
    };

    const r = await GET(new Request("http://localhost/api/admin/analytics/engagement?period=30d"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data).toEqual({
      trainers: [
        {
          trainerId: "t1",
          name: "Chris Waller",
          horses: 5,
          posts: 12,
          opens: 300,
          reactions: 40,
          saves: 10,
          websiteClicks: 8,
        },
      ],
      horses: [{ horseId: "h1", name: "Winx", trainerName: "Chris Waller", posts: 3, opens: 90, reactions: 12, saves: 4 }],
      topPosts: [{ postId: "p1", title: "Big win", horseName: "Winx", type: "update", opens: 90, reactions: 12, saves: 4 }],
    });
  });

  it("passes a null p_since for period=all and p_limit 10 to top posts", async () => {
    asAdmin();
    const r = await GET(new Request("http://localhost/api/admin/analytics/engagement?period=all"));
    expect(r.status).toBe(200);
    const trainerCall = state.calls.rpc.find((c) => c.name === "admin_trainer_engagement");
    expect(trainerCall?.args).toEqual({ p_since: null });
    const topPostsCall = state.calls.rpc.find((c) => c.name === "admin_top_posts");
    expect(topPostsCall?.args).toEqual({ p_since: null, p_limit: 10 });
  });
});
