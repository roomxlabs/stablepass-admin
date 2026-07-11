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
  return new Request("http://t/api/admin/horses/h1", { method: "PATCH", body: JSON.stringify(body) });
}
const ctx = () => ({ params: Promise.resolve({ id: "h1" }) });

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("PATCH /api/admin/horses/:id — edit", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await PATCH(patchReq({ trainingStatus: "retired" }), ctx());
    expect(r.status).toBe(403);
  });

  it("updates editable attributes -> 200", async () => {
    asAdmin();
    state.tables.horse = { mutate: { single: { id: "h1", training_status: "retired", story: "Champion." } } };
    const r = await PATCH(patchReq({ trainingStatus: "retired", story: "Champion." }), ctx());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.training_status).toBe("retired");
  });

  it("400 when no editable fields are provided (owner is ignored)", async () => {
    asAdmin();
    const r = await PATCH(patchReq({ owner: "nope" }), ctx());
    expect(r.status).toBe(400);
  });

  it("404 when the horse does not exist", async () => {
    asAdmin();
    state.tables.horse = { mutate: { single: null } };
    const r = await PATCH(patchReq({ status: "disabled" }), ctx());
    expect(r.status).toBe(404);
    const j = await r.json();
    expect(j.error.code).toBe("not_found");
  });
});
