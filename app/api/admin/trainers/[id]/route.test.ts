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
  return new Request("http://t/api/admin/trainers/t1", { method: "PATCH", body: JSON.stringify(body) });
}
const ctx = { params: Promise.resolve({ id: "t1" }) };

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("PATCH /api/admin/trainers/:id — update trainer", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await PATCH(patchReq({ status: "onboarding" }), ctx);
    expect(r.status).toBe(403);
  });

  it("updates present fields → 200", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { single: { id: "t1", name: "Chris Waller", status: "onboarding" } } };
    const r = await PATCH(patchReq({ status: "onboarding", location: "Rosehill, NSW" }), ctx);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.status).toBe("onboarding");
  });

  it("404s when the trainer does not exist (no row)", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { error: { code: "PGRST116", message: "no rows" } } };
    const r = await PATCH(patchReq({ name: "X" }), ctx);
    expect(r.status).toBe(404);
    const j = await r.json();
    expect(j.error.code).toBe("not_found");
  });

  it("patches marketing_visible when the toggle flips on", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { single: { id: "t1" } } };
    const r = await PATCH(patchReq({ marketingVisible: true }), ctx);
    expect(r.status).toBe(200);
    const upd = state.calls.mutations.find((m) => m.table === "trainer" && m.op === "update");
    expect(upd?.payload.marketing_visible).toBe(true);
  });

  it("patches marketing_photo_path when the public copy lands", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { single: { id: "t1" } } };
    const r = await PATCH(patchReq({ marketingPhotoPath: "trainers/t1.jpg" }), ctx);
    expect(r.status).toBe(200);
    const upd = state.calls.mutations.find((m) => m.table === "trainer" && m.op === "update");
    expect(upd?.payload.marketing_photo_path).toBe("trainers/t1.jpg");
  });

  it("nulls marketing_photo_path when the trainer is taken off the site", async () => {
    asAdmin();
    state.tables.trainer = { mutate: { single: { id: "t1" } } };
    const r = await PATCH(patchReq({ marketingVisible: false, marketingPhotoPath: null }), ctx);
    expect(r.status).toBe(200);
    const upd = state.calls.mutations.find((m) => m.table === "trainer" && m.op === "update");
    // A null path MUST survive the validation — this is the un-publish path.
    expect(upd?.payload.marketing_photo_path).toBe(null);
    expect(upd?.payload.marketing_visible).toBe(false);
  });

  it("400s on an absolute marketing photo path", async () => {
    asAdmin();
    const r = await PATCH(patchReq({ marketingPhotoPath: "/etc/passwd" }), ctx);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });

  it("400s on a traversal marketing photo path", async () => {
    asAdmin();
    const r = await PATCH(patchReq({ marketingPhotoPath: "../trainer-photos/x.jpg" }), ctx);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });

  it("400s when marketingVisible is not a boolean", async () => {
    asAdmin();
    const r = await PATCH(patchReq({ marketingVisible: "yes" }), ctx);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });
});
