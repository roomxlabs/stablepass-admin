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
  return new Request(`http://t/api/admin/waitlist${qs}`);
}

const ROWS = [
  { id: "1", email: "b@example.com", source: "marketing", created_at: "2026-09-02T10:00:00Z" },
  { id: "2", email: "a@example.com", source: "marketing", created_at: "2026-09-01T10:00:00Z" },
];

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("GET /api/admin/waitlist", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await GET(req());
    expect(r.status).toBe(403);
  });

  it("403s with mfa_required for an admin whose session is only AAL1 (guardrail)", async () => {
    asAdmin();
    state.aal = "aal1";
    const r = await GET(req());
    expect(r.status).toBe(403);
    const j = await r.json();
    expect(j.error.code).toBe("mfa_required");
  });

  it("200s for an admin, reading only the waitlist table", async () => {
    asAdmin();
    state.tables.waitlist = { select: { rows: ROWS, count: 2 } };
    const r = await GET(req());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data).toEqual([
      { id: "1", email: "b@example.com", source: "marketing", joinedAt: "2026-09-02T10:00:00Z" },
      { id: "2", email: "a@example.com", source: "marketing", joinedAt: "2026-09-01T10:00:00Z" },
    ]);
    expect(j.meta).toEqual({ total: 2, matching: 2, offset: 0, limit: 25 });
    expect([...new Set(state.calls.from)].sort()).toEqual(["app_user", "waitlist"]);
  });

  it("clamps ?limit= to 200", async () => {
    asAdmin();
    state.tables.waitlist = { select: { rows: ROWS, count: 2 } };
    const r = await GET(req("?limit=999"));
    const j = await r.json();
    expect(j.meta.limit).toBe(200);
  });
});
