import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

// ENG-370 guardrail, proved END TO END through a REAL admin route handler
// rather than against the gate in isolation.
//
// Why this file exists: `blankState()` now defaults to `aal: "aal2"` so that
// every pre-existing route test keeps asserting what it was written to assert.
// That default means none of them would ever exercise the AAL1 branch — so the
// acceptance criterion "an AAL1 admin hitting any app/api/admin/* route gets
// 403, not 200 and not empty data" would be untested at the route layer.
//
// The failure mode this pins down is specifically nasty: after ENG-368,
// Postgres's `is_admin()` also requires aal2, so an AAL1 admin's reads come back
// as 0 rows WITH NO ERROR. A route that let AAL1 through would answer 200 with a
// convincingly empty list instead of refusing — which is exactly what a
// half-authenticated session must never get.
const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));
vi.mock("@/lib/mux", () => ({
  MuxError: class MuxError extends Error {},
  createMuxDirectUpload: async () => ({ uploadId: "up_1", uploadUrl: "https://mux.local/u" }),
}));

import { GET } from "@/app/api/admin/posts/route";

function req() {
  return new Request("http://t/api/admin/posts");
}

beforeEach(() => {
  Object.assign(state, blankState());
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
  // A populated table, so a 200 here would be a real leak rather than an
  // artefact of there being nothing to return.
  state.tables.post = { select: { rows: [{ id: "p1", title: "secret" }], count: 1 } };
});

describe("guardrail — an AAL1 admin on a real admin route", () => {
  it("gets 403 mfa_required, never 200 and never empty data", async () => {
    state.aal = "aal1";
    const r = await GET(req());
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error.code).toBe("mfa_required");
    expect(body).not.toHaveProperty("data");
  });

  it("still 401s with no session at all (unchanged)", async () => {
    state.user = null;
    const r = await GET(req());
    expect(r.status).toBe(401);
  });

  it("still 403s a non-admin, whatever their assurance level (unchanged)", async () => {
    state.tables.app_user = { select: { single: { is_admin: false } } };
    state.aal = "aal2";
    const r = await GET(req());
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error.code).toBe("forbidden");
  });

  it("lets the same admin through once the session is aal2", async () => {
    state.aal = "aal2";
    const r = await GET(req());
    expect(r.status).toBe(200);
  });
});
