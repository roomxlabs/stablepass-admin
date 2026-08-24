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
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const patchReq = (body: unknown) => new Request("http://t", { method: "PATCH", body: JSON.stringify(body) });

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("DELETE /api/admin/posts/:id — discard draft only", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await DELETE(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(403);
  });

  it("204 when the post is a draft", async () => {
    asAdmin();
    state.tables.post = { select: { single: { status: "draft" } } };
    const r = await DELETE(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(204);
  });

  it("409 when the post is published (soft-hide only, never hard-delete)", async () => {
    asAdmin();
    state.tables.post = { select: { single: { status: "published" } } };
    const r = await DELETE(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("not_a_draft");
  });

  it("404 when the post is missing", async () => {
    asAdmin();
    state.tables.post = { select: { single: null } };
    const r = await DELETE(new Request("http://t"), ctx("p1"));
    expect(r.status).toBe(404);
  });
});

describe("PATCH /api/admin/posts/:id — edit fields", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await PATCH(patchReq({ title: "x" }), ctx("p1"));
    expect(r.status).toBe(403);
  });

  it("edits fields → 200", async () => {
    asAdmin();
    state.tables.post = { mutate: { single: { id: "p1", title: "New" } } };
    const r = await PATCH(patchReq({ title: "New", sourceTrainerId: "t2" }), ctx("p1"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.title).toBe("New");
  });

  it("404 when the post is missing", async () => {
    asAdmin();
    state.tables.post = { mutate: { single: null } };
    const r = await PATCH(patchReq({ title: "New" }), ctx("p1"));
    expect(r.status).toBe(404);
  });

  // ENG-745 — post-label presets.
  it("a valid preset label is written to the label column", async () => {
    asAdmin();
    state.tables.post = { mutate: { single: { id: "p1", label: "Trackwork" } } };
    const r = await PATCH(patchReq({ label: "Trackwork" }), ctx("p1"));
    expect(r.status).toBe(200);
    const updateCall = state.calls.mutations.find((m) => m.table === "post" && m.op === "update");
    expect(updateCall?.payload).toMatchObject({ label: "Trackwork" });
  });

  it("label: null clears the category — update payload carries label: null", async () => {
    asAdmin();
    state.tables.post = { mutate: { single: { id: "p1", label: null } } };
    const r = await PATCH(patchReq({ label: null }), ctx("p1"));
    expect(r.status).toBe(200);
    const updateCall = state.calls.mutations.find((m) => m.table === "post" && m.op === "update");
    expect(updateCall?.payload).toMatchObject({ label: null });
  });

  it("absent label is left alone — the update payload has no label key at all", async () => {
    asAdmin();
    state.tables.post = { mutate: { single: { id: "p1", title: "New" } } };
    await PATCH(patchReq({ title: "New" }), ctx("p1"));
    const updateCall = state.calls.mutations.find((m) => m.table === "post" && m.op === "update");
    expect(updateCall?.payload).not.toHaveProperty("label");
  });

  it("an off-list label ('Betting Tips') → 400 validation_failed, no update attempted", async () => {
    asAdmin();
    const r = await PATCH(patchReq({ label: "Betting Tips" }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
    expect(state.calls.mutations).toHaveLength(0);
  });

  it("update violating the label CHECK (23514) → 400 validation_failed, not update_failed", async () => {
    asAdmin();
    state.tables.post = { mutate: { error: { code: "23514", message: "check violation" } } };
    const r = await PATCH(patchReq({ label: "Trackwork" }), ctx("p1"));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });
});
