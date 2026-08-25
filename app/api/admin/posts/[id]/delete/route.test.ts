import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

import { DELETE } from "./route";

function asAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: true } } };
}
function asNonAdmin() {
  state.user = { id: "u1" };
  state.tables.app_user = { select: { single: { is_admin: false } } };
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://t", { method: "DELETE" });

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("DELETE /api/admin/posts/:id/delete — hard delete, ANY status", () => {
  it("403s for a non-admin (guardrail §1)", async () => {
    asNonAdmin();
    const r = await DELETE(req(), ctx("p1"));
    expect(r.status).toBe(403);
  });

  it("403s an admin whose session is only AAL1", async () => {
    asAdmin();
    state.aal = "aal1";
    const r = await DELETE(req(), ctx("p1"));
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("mfa_required");
  });

  // The whole point of the route: the draft-only sibling 409s these, which is
  // why demo data could never be cleaned out of production.
  for (const status of ["draft", "scheduled", "published", "unpublished"] as const) {
    it(`204s a ${status} post`, async () => {
      asAdmin();
      state.tables.post = { select: { single: { id: "p1", status } }, mutate: {} };
      const r = await DELETE(req(), ctx("p1"));
      expect(r.status).toBe(204);
    });
  }

  it("deletes exactly the addressed row", async () => {
    asAdmin();
    state.tables.post = { select: { single: { id: "p1" } }, mutate: {} };
    await DELETE(req(), ctx("p1"));
    const del = state.calls.mutations.find((m) => m.table === "post" && m.op === "delete");
    expect(del).toBeTruthy();
    expect(del?.filters).toEqual([{ column: "id", value: "p1" }]);
  });

  it("404s a missing post rather than reporting a silent success", async () => {
    asAdmin();
    state.tables.post = { select: { single: null } };
    const r = await DELETE(req(), ctx("p1"));
    expect(r.status).toBe(404);
  });
});
