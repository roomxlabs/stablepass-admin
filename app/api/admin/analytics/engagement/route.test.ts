import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

import { GET } from "./route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true }, rows: [{ id: "admin-1" }] } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}

const post = { id: "p1", source_trainer_id: "t1", horse_id: "h1" };

function seedRpcSkeleton() {
  state.rpcs.admin_trainer_engagement = {
    data: [{ trainer_id: "t1", name: "Chris Waller", horses: 5, posts: 12 }],
  };
  state.rpcs.admin_horse_engagement = {
    data: [{ horse_id: "h1", name: "Winx", trainer_name: "Chris Waller", posts: 3 }],
  };
  state.rpcs.admin_top_posts = {
    data: [{ post_id: "p1", title: "Big win", horse_name: "Winx", type: "update" }],
  };
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

  it("returns trainer/horse/top-post engagement, excluding admin activity, for an admin (ENG-984)", async () => {
    asAdmin();
    seedRpcSkeleton();
    state.tables.impression = {
      select: {
        rows: [
          { user_id: "admin-1", post },
          { user_id: "member-1", post },
          { user_id: "member-2", post },
        ],
      },
    };
    state.tables.reaction = {
      select: { rows: [{ user_id: "member-1", post }] },
    };
    state.tables.bookmark = {
      select: { rows: [{ user_id: "member-1", post }] },
    };
    state.tables.trainer_website_click = {
      select: {
        rows: [
          { user_id: "member-1", trainer_id: "t1" },
          { user_id: "admin-1", trainer_id: "t1" },
        ],
      },
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
          opens: 2,
          reactions: 1,
          saves: 1,
          websiteClicks: 1,
        },
      ],
      horses: [{ horseId: "h1", name: "Winx", trainerName: "Chris Waller", posts: 3, opens: 2, reactions: 1, saves: 1 }],
      topPosts: [{ postId: "p1", title: "Big win", horseName: "Winx", type: "update", opens: 2, reactions: 1, saves: 1 }],
    });
  });

  it("passes a null p_since for period=all and p_limit 100 to top posts (re-ranking headroom, ENG-984)", async () => {
    asAdmin();
    const r = await GET(new Request("http://localhost/api/admin/analytics/engagement?period=all"));
    expect(r.status).toBe(200);
    const trainerCall = state.calls.rpc.find((c) => c.name === "admin_trainer_engagement");
    expect(trainerCall?.args).toEqual({ p_since: null });
    const topPostsCall = state.calls.rpc.find((c) => c.name === "admin_top_posts");
    expect(topPostsCall?.args).toEqual({ p_since: null, p_limit: 100 });
  });

  it("a post with only admin engagement contributes zero to its trainer/horse/topPost", async () => {
    asAdmin();
    seedRpcSkeleton();
    state.tables.impression = { select: { rows: [{ user_id: "admin-1", post }] } };
    state.tables.reaction = { select: { rows: [{ user_id: "admin-1", post }] } };
    state.tables.bookmark = { select: { rows: [{ user_id: "admin-1", post }] } };

    const r = await GET(new Request("http://localhost/api/admin/analytics/engagement"));
    const j = await r.json();
    expect(j.data.trainers[0]).toMatchObject({ opens: 0, reactions: 0, saves: 0 });
    expect(j.data.horses[0]).toMatchObject({ opens: 0, reactions: 0, saves: 0 });
    expect(j.data.topPosts[0]).toMatchObject({ opens: 0, reactions: 0, saves: 0 });
  });

  it("500s with a generic message when an rpc errors (no schema/SQL leakage)", async () => {
    asAdmin();
    state.rpcs.admin_trainer_engagement = { error: { message: 'relation "impression" does not exist' } };
    const r = await GET(new Request("http://localhost/api/admin/analytics/engagement?period=7d"));
    expect(r.status).toBe(500);
    const j = await r.json();
    expect(j.error.code).toBe("query_failed");
    expect(JSON.stringify(j)).not.toMatch(/relation|does not exist/);
  });
});
