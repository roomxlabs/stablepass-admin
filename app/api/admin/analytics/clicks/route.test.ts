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

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("GET /api/admin/analytics/clicks", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await GET(new Request("http://localhost/api/admin/analytics/clicks"));
    expect(r.status).toBe(403);
  });

  it("401s with no session", async () => {
    const r = await GET(new Request("http://localhost/api/admin/analytics/clicks"));
    expect(r.status).toBe(401);
  });

  it("400s for an invalid period", async () => {
    asAdmin();
    const r = await GET(new Request("http://localhost/api/admin/analytics/clicks?period=90d"));
    expect(r.status).toBe(400);
  });

  it("returns member-only clicks by trainer for an admin (ENG-984)", async () => {
    asAdmin();
    state.rpcs.admin_clicks_by_trainer = {
      data: [{ trainer_id: "t1", name: "Chris Waller", clicks: 22, last_click: "2026-07-15T00:00:00.000Z" }],
    };
    state.tables.trainer_website_click = {
      select: {
        rows: [
          { user_id: "member-1", trainer_id: "t1", clicked_at: "2026-07-10T00:00:00.000Z" },
          { user_id: "member-2", trainer_id: "t1", clicked_at: "2026-07-15T00:00:00.000Z" },
          { user_id: "admin-1", trainer_id: "t1", clicked_at: "2026-07-16T00:00:00.000Z" },
        ],
      },
    };

    const r = await GET(new Request("http://localhost/api/admin/analytics/clicks?period=7d"));
    expect(r.status).toBe(200);
    const j = await r.json();
    // 2 member clicks (admin's excluded), lastClick is the later MEMBER click —
    // the admin's later click must not surface as lastClick either.
    expect(j.data).toEqual({
      trainers: [{ trainerId: "t1", name: "Chris Waller", clicks: 2, lastClick: "2026-07-15T00:00:00.000Z" }],
    });
  });

  it("drops a trainer whose only clicks were the admin's (RPC saw non-zero, member count is zero)", async () => {
    asAdmin();
    state.rpcs.admin_clicks_by_trainer = {
      data: [
        { trainer_id: "t1", name: "Chris Waller", clicks: 22, last_click: "2026-07-15T00:00:00.000Z" },
        { trainer_id: "t2", name: "Gai Waterhouse", clicks: 5, last_click: "2026-07-10T00:00:00.000Z" },
      ],
    };
    state.tables.trainer_website_click = {
      select: {
        rows: [
          { user_id: "member-1", trainer_id: "t1", clicked_at: "2026-07-10T00:00:00.000Z" },
          { user_id: "admin-1", trainer_id: "t2", clicked_at: "2026-07-10T00:00:00.000Z" },
        ],
      },
    };

    const r = await GET(new Request("http://localhost/api/admin/analytics/clicks"));
    const j = await r.json();
    expect(j.data.trainers.map((t: { trainerId: string }) => t.trainerId)).toEqual(["t1"]);
  });

  it("passes a null p_since for period=all", async () => {
    asAdmin();
    const r = await GET(new Request("http://localhost/api/admin/analytics/clicks?period=all"));
    expect(r.status).toBe(200);
    const call = state.calls.rpc.find((c) => c.name === "admin_clicks_by_trainer");
    expect(call?.args).toEqual({ p_since: null });
  });

  it("guardrail: a trainer row never contains a user-level field", async () => {
    asAdmin();
    state.rpcs.admin_clicks_by_trainer = {
      data: [{ trainer_id: "t1", name: "Chris Waller", clicks: 22, last_click: null }],
    };
    state.tables.trainer_website_click = {
      select: { rows: [{ user_id: "member-1", trainer_id: "t1", clicked_at: "2026-07-01T00:00:00.000Z" }] },
    };
    const r = await GET(new Request("http://localhost/api/admin/analytics/clicks"));
    const j = await r.json();
    const row = j.data.trainers[0];
    expect(Object.keys(row).sort()).toEqual(["clicks", "lastClick", "name", "trainerId"]);
    expect(row).not.toHaveProperty("userId");
    expect(row).not.toHaveProperty("user_id");
    expect(row).not.toHaveProperty("email");
  });

  it("500s with a generic message when an rpc errors (no schema/SQL leakage)", async () => {
    asAdmin();
    state.rpcs.admin_clicks_by_trainer = { error: { message: 'relation "trainer_website_click" does not exist' } };
    const r = await GET(new Request("http://localhost/api/admin/analytics/clicks?period=7d"));
    expect(r.status).toBe(500);
    const j = await r.json();
    expect(j.error.code).toBe("query_failed");
    expect(JSON.stringify(j)).not.toMatch(/relation|does not exist/);
  });
});
