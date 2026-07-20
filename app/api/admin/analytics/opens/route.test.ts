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

describe("GET /api/admin/analytics/opens", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await GET(new Request("http://localhost/api/admin/analytics/opens"));
    expect(r.status).toBe(403);
  });

  it("401s for no session", async () => {
    const r = await GET(new Request("http://localhost/api/admin/analytics/opens"));
    expect(r.status).toBe(401);
  });

  it("400s for an invalid period", async () => {
    asAdmin();
    const r = await GET(new Request("http://localhost/api/admin/analytics/opens?period=90d"));
    expect(r.status).toBe(400);
  });

  it("returns opens by day + hour for an admin", async () => {
    asAdmin();
    state.rpcs.admin_opens_by_day = { data: [{ day: "2026-07-01", opens: 10 }] };
    state.rpcs.admin_opens_by_hour = { data: [{ hour: 9, opens: 3 }] };

    const r = await GET(new Request("http://localhost/api/admin/analytics/opens?period=7d"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data).toEqual({
      byDay: [{ day: "2026-07-01", opens: 10 }],
      byHour: [{ hour: 9, opens: 3 }],
    });
  });

  it("coerces a string bigint opens count to a number (PostgREST bigints can come back as strings)", async () => {
    asAdmin();
    state.rpcs.admin_opens_by_day = { data: [{ day: "2026-07-01", opens: "10" }] };
    state.rpcs.admin_opens_by_hour = { data: [] };

    const r = await GET(new Request("http://localhost/api/admin/analytics/opens?period=7d"));
    const j = await r.json();
    expect(j.data.byDay).toEqual([{ day: "2026-07-01", opens: 10 }]);
  });

  it("500s with a generic message when an rpc errors (no schema/SQL leakage)", async () => {
    asAdmin();
    state.rpcs.admin_opens_by_day = { error: { message: 'relation "impression" does not exist' } };
    const r = await GET(new Request("http://localhost/api/admin/analytics/opens"));
    expect(r.status).toBe(500);
    const j = await r.json();
    expect(j.error.code).toBe("query_failed");
    const bodyText = JSON.stringify(j);
    expect(bodyText).not.toMatch(/relation/);
  });

  it("passes a null p_since for period=all", async () => {
    asAdmin();
    const r = await GET(new Request("http://localhost/api/admin/analytics/opens?period=all"));
    expect(r.status).toBe(200);
    const call = state.calls.rpc.find((c) => c.name === "admin_opens_by_day");
    expect(call?.args).toEqual({ p_since: null });
  });
});
