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

  it("returns clicks by trainer for an admin", async () => {
    asAdmin();
    state.rpcs.admin_clicks_by_trainer = {
      data: [{ trainer_id: "t1", name: "Chris Waller", clicks: 22, last_click: "2026-07-15T00:00:00.000Z" }],
    };

    const r = await GET(new Request("http://localhost/api/admin/analytics/clicks?period=7d"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data).toEqual({
      trainers: [{ trainerId: "t1", name: "Chris Waller", clicks: 22, lastClick: "2026-07-15T00:00:00.000Z" }],
    });
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
    const r = await GET(new Request("http://localhost/api/admin/analytics/clicks"));
    const j = await r.json();
    const row = j.data.trainers[0];
    expect(Object.keys(row).sort()).toEqual(["clicks", "lastClick", "name", "trainerId"]);
    expect(row).not.toHaveProperty("userId");
    expect(row).not.toHaveProperty("user_id");
    expect(row).not.toHaveProperty("email");
  });
});
