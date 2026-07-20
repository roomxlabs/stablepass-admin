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

describe("GET /api/admin/analytics/trials", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await GET(new Request("http://localhost/api/admin/analytics/trials"));
    expect(r.status).toBe(403);
  });

  it("401s with no session", async () => {
    const r = await GET(new Request("http://localhost/api/admin/analytics/trials"));
    expect(r.status).toBe(401);
  });

  it("400s for an unrecognised format", async () => {
    asAdmin();
    const r = await GET(new Request("http://localhost/api/admin/analytics/trials?format=xlsx"));
    expect(r.status).toBe(400);
  });

  it("returns byMonth + list for an admin", async () => {
    asAdmin();
    state.rpcs.admin_trials_by_month = { data: [{ month: "2026-07-01", started: 5, converted: 2 }] };
    state.tables.subscription = {
      select: {
        rows: [
          {
            status: "trial",
            trial_ends_at: "2026-08-01T00:00:00.000Z",
            created_at: "2026-07-15T00:00:00.000Z",
            user: { name: "Jo Bloggs", email: "jo@example.com" },
          },
        ],
      },
    };

    const r = await GET(new Request("http://localhost/api/admin/analytics/trials"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.byMonth).toEqual([{ month: "2026-07-01", started: 5, converted: 2 }]);
    expect(j.data.list[0]).toEqual({
      name: "Jo Bloggs",
      email: "jo@example.com",
      startedAt: "2026-07-15T00:00:00.000Z",
      endsAt: "2026-08-01T00:00:00.000Z",
      daysLeft: j.data.list[0].daysLeft,
      status: "trial",
    });
  });

  it("computes daysLeft: a future trial_ends_at is positive, an expired one is clamped to 0", async () => {
    vi.setSystemTime(new Date("2026-07-20T00:00:00.000Z"));
    asAdmin();
    state.rpcs.admin_trials_by_month = { data: [] };
    state.tables.subscription = {
      select: {
        rows: [
          {
            status: "trial",
            trial_ends_at: "2026-07-25T00:00:00.000Z", // 5 days in the future
            created_at: "2026-07-15T00:00:00.000Z",
            user: { name: "Future Trial", email: "future@example.com" },
          },
          {
            status: "lapsed",
            trial_ends_at: "2026-07-01T00:00:00.000Z", // expired
            created_at: "2026-06-15T00:00:00.000Z",
            user: { name: "Expired Trial", email: "expired@example.com" },
          },
        ],
      },
    };

    const r = await GET(new Request("http://localhost/api/admin/analytics/trials"));
    const j = await r.json();
    expect(j.data.list[0].daysLeft).toBe(5);
    expect(j.data.list[1].daysLeft).toBe(0);
    vi.useRealTimers();
  });

  it("returns a CSV export when format=csv", async () => {
    asAdmin();
    state.rpcs.admin_trials_by_month = { data: [] };
    state.tables.subscription = {
      select: {
        rows: [
          {
            status: "trial",
            trial_ends_at: "2026-08-01T00:00:00.000Z",
            created_at: "2026-07-15T00:00:00.000Z",
            user: [{ name: "Jo Bloggs", email: "jo@example.com" }],
          },
        ],
      },
    };

    const r = await GET(new Request("http://localhost/api/admin/analytics/trials?format=csv"));
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")?.startsWith("text/csv")).toBe(true);
    expect(r.headers.get("Content-Disposition")).toMatch(
      /attachment; filename="stablepass-trials-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    const body = await r.text();
    const lines = body.split("\r\n");
    expect(lines[0]).toBe("name,email,trial_start,trial_end,status");
    expect(lines[1]).toBe("Jo Bloggs,jo@example.com,2026-07-15T00:00:00.000Z,2026-08-01T00:00:00.000Z,trial");
  });
});
