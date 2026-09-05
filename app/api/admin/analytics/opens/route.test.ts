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

  it("returns opens by day + hour, bucketed in UTC, for an admin", async () => {
    asAdmin();
    state.tables.impression = {
      select: {
        rows: [
          { user_id: "member-1", seen_at: "2026-07-01T09:15:00.000Z" },
          { user_id: "member-1", seen_at: "2026-07-01T09:45:00.000Z" },
          { user_id: "member-2", seen_at: "2026-07-01T14:00:00.000Z" },
        ],
      },
    };

    const r = await GET(new Request("http://localhost/api/admin/analytics/opens?period=7d"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data).toEqual({
      byDay: [{ day: "2026-07-01", opens: 3 }],
      byHour: [
        { hour: 9, opens: 2 },
        { hour: 14, opens: 1 },
      ],
    });
  });

  it("excludes admin activity: only member impressions are counted (ENG-984)", async () => {
    asAdmin();
    state.tables.app_user = {
      select: { single: { is_admin: true }, rows: [{ id: "admin-1" }] },
    };
    state.tables.impression = {
      select: {
        rows: [
          { user_id: "admin-1", seen_at: "2026-07-01T09:00:00.000Z" },
          { user_id: "admin-1", seen_at: "2026-07-01T09:05:00.000Z" },
          { user_id: "member-1", seen_at: "2026-07-01T09:10:00.000Z" },
        ],
      },
    };

    const r = await GET(new Request("http://localhost/api/admin/analytics/opens"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data).toEqual({
      byDay: [{ day: "2026-07-01", opens: 1 }],
      byHour: [{ hour: 9, opens: 1 }],
    });
  });

  it("returns empty buckets when there are no impressions", async () => {
    asAdmin();
    const r = await GET(new Request("http://localhost/api/admin/analytics/opens?period=7d"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data).toEqual({ byDay: [], byHour: [] });
  });

  it("500s with a generic message when the impression read errors (no schema/SQL leakage)", async () => {
    asAdmin();
    state.tables.impression = { select: { error: { message: 'relation "impression" does not exist' } } };
    const r = await GET(new Request("http://localhost/api/admin/analytics/opens"));
    expect(r.status).toBe(500);
    const j = await r.json();
    expect(j.error.code).toBe("query_failed");
    const bodyText = JSON.stringify(j);
    expect(bodyText).not.toMatch(/relation/);
  });
});
