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
  return new Request("http://t/api/admin/trainers", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("POST /api/admin/trainers — create trainer", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await POST(postReq({ name: "Chris Waller", slug: "chris-waller" }));
    expect(r.status).toBe(403);
  });

  it("creates a trainer → 201 + data", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { single: { id: "t1", name: "Chris Waller", slug: "chris-waller", status: "active" } } };
    const r = await POST(postReq({ name: "Chris Waller", slug: "chris-waller", stableName: "Chris Waller Racing" }));
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.data.id).toBe("t1");
    expect(j.data.slug).toBe("chris-waller");
  });

  it("400s when name or slug is missing", async () => {
    asAdmin();
    const r = await POST(postReq({ name: "No Slug" }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });

  it("409s when the slug is already taken (unique violation)", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { error: { code: "23505", message: "duplicate key" } } };
    const r = await POST(postReq({ name: "Chris Waller", slug: "chris-waller" }));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("slug_taken");
  });
});
