import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

import { PATCH, DELETE } from "./route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
const ctx = { params: Promise.resolve({ id: "c1" }) };
function patchReq(body: unknown): Request {
  return new Request("http://t/api/admin/contacts/c1", { method: "PATCH", body: JSON.stringify(body) });
}

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("PATCH /api/admin/contacts/:id — edit contact", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await PATCH(patchReq({ role: "Racing manager" }), ctx);
    expect(r.status).toBe(403);
  });

  it("updates present fields → 200", async () => {
    asAdmin();
    state.tables.trainer_contact = { mutate: { single: { id: "c1", trainer_id: "t1", role: "Racing manager", name: "Sam" } } };
    const r = await PATCH(patchReq({ role: "Racing manager", name: "Sam" }), ctx);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.role).toBe("Racing manager");
  });
});

describe("DELETE /api/admin/contacts/:id — remove contact", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await DELETE(new Request("http://t/api/admin/contacts/c1", { method: "DELETE" }), ctx);
    expect(r.status).toBe(403);
  });

  it("deletes → 204", async () => {
    asAdmin();
    state.tables.trainer_contact = { mutate: {} };
    const r = await DELETE(new Request("http://t/api/admin/contacts/c1", { method: "DELETE" }), ctx);
    expect(r.status).toBe(204);
  });
});
