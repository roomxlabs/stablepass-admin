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
function req(qs = ""): Request {
  return new Request(`http://t/api/admin/subscribers${qs}`);
}

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("GET /api/admin/subscribers", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await GET(req());
    expect(r.status).toBe(403);
  });

  it("returns aggregate counts by status (no member PII)", async () => {
    asAdmin();
    state.tables.subscription = {
      select: {
        rows: [
          { status: "active" },
          { status: "active" },
          { status: "trial" },
          { status: "canceled" },
        ],
      },
    };
    const r = await GET(req());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.total).toBe(4);
    expect(j.data.byStatus).toEqual({ active: 2, trial: 1, canceled: 1 });
    // Aggregate-only guardrail: never leak a user_id / member row.
    expect(JSON.stringify(j.data)).not.toContain("user_id");
  });

  it("returns an empty aggregate when there are no subscribers", async () => {
    asAdmin();
    const r = await GET(req("?status=active"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.total).toBe(0);
    expect(j.data.byStatus).toEqual({});
  });
});
