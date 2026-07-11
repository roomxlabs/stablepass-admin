import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

import { POST } from "./route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
function postReq(body: unknown): Request {
  return new Request("http://t/api/admin/trainers/t1/contacts", { method: "POST", body: JSON.stringify(body) });
}
const ctx = { params: Promise.resolve({ id: "t1" }) };

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("POST /api/admin/trainers/:id/contacts — add internal contact", () => {
  it("403s for a non-admin (guardrail: trainer_contact is admin-only)", async () => {
    asNonAdmin();
    const r = await POST(postReq({ role: "Trainer", name: "Chris Waller" }), ctx);
    expect(r.status).toBe(403);
  });

  it("creates a contact → 201 + data", async () => {
    asAdmin();
    state.tables.trainer_contact = {
      mutate: { single: { id: "c1", trainer_id: "t1", role: "Trainer", name: "Chris Waller", email: "chris@waller.au", phone: null } },
    };
    const r = await POST(postReq({ role: "Trainer", name: "Chris Waller", email: "chris@waller.au" }), ctx);
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.data.id).toBe("c1");
    expect(j.data.trainer_id).toBe("t1");
  });

  it("400s when role or name is missing", async () => {
    asAdmin();
    const r = await POST(postReq({ email: "x@y.z" }), ctx);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });
});
