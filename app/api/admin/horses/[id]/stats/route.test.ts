import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

import { PATCH } from "./route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
function patchReq(body: unknown): Request {
  return new Request("http://t/api/admin/horses/h1/stats", { method: "PATCH", body: JSON.stringify(body) });
}
const ctx = () => ({ params: Promise.resolve({ id: "h1" }) });

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("PATCH /api/admin/horses/:id/stats — manual stats", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await PATCH(patchReq({ starts: 1 }), ctx());
    expect(r.status).toBe(403);
  });

  it("updates stats -> 200", async () => {
    asAdmin();
    state.tables.horse = {
      mutate: { single: { id: "h1", starts: 24, wins: 6, places: 9, prize_money_cents: 1200000 } },
    };
    const r = await PATCH(patchReq({ starts: 24, wins: 6, places: 9, prizeMoneyCents: 1200000 }), ctx());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.wins).toBe(6);
    expect(j.data.prize_money_cents).toBe(1200000);
  });

  it("400 for a negative stat", async () => {
    asAdmin();
    const r = await PATCH(patchReq({ wins: -1 }), ctx());
    expect(r.status).toBe(400);
  });

  it("404 when the horse does not exist", async () => {
    asAdmin();
    state.tables.horse = { mutate: { single: null } };
    const r = await PATCH(patchReq({ starts: 5 }), ctx());
    expect(r.status).toBe(404);
  });
});
