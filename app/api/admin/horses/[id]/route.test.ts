import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";
import { recordCalls, blankRecord, type CallRecord } from "@/lib/testing/call-recorder";

const state: FakeState = blankState();
// Payload-recording wrapper: the shared fake discards builder arguments, so
// without this neither a wrong `update` nor an IDOR (`.eq("id", …)` pointing at
// someone else's row) would be visible to a test.
const rec: CallRecord = blankRecord();
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => recordCalls(makeFakeClient(state), rec),
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
  Object.assign(rec, blankRecord());
});

describe("PATCH /api/admin/horses/:id — edit", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await PATCH(patchReq({ trainingStatus: "retired" }), ctx());
    expect(r.status).toBe(403);
    // `forbidden`, not `mfa_required` — a non-admin is not an admin who needs 2FA.
    expect((await r.json()).error.code).toBe("forbidden");
    expect(rec.writes).toEqual([]);
  });

  it("updates editable attributes -> 200", async () => {
    asAdmin();
    state.tables.horse = { mutate: { single: { id: "h1", training_status: "retired", story: "Champion." } } };
    const r = await PATCH(patchReq({ trainingStatus: "retired", story: "Champion." }), ctx());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.training_status).toBe("retired");
    // Scoped to the horse in the path, not to whatever the body asked for.
    expect(rec.filters).toContain("horse.id=h1");
  });

  it("400 when no editable fields are provided (owner is ignored)", async () => {
    asAdmin();
    const r = await PATCH(patchReq({ owner: "nope" }), ctx());
    expect(r.status).toBe(400);
    expect(rec.writes).toEqual([]);
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

describe("PATCH /api/admin/horses/:id — sex + gelded (ENG-616)", () => {
  beforeEach(() => {
    asAdmin();
    state.tables.horse = { mutate: { single: { id: "h1" } } };
  });

  it("accepts {sex:'male', isGelded:true} and WRITES both columns", async () => {
    const r = await PATCH(patchReq({ sex: "male", isGelded: true }), ctx());
    expect(r.status).toBe(200);
    expect(rec.writes).toHaveLength(1);
    expect(rec.writes[0].op).toBe("update");
    expect(rec.writes[0].payload).toMatchObject({ sex: "male", is_gelded: true });
  });

  it("un-gelds and switches to female in one update", async () => {
    const r = await PATCH(patchReq({ sex: "female", isGelded: false }), ctx());
    expect(r.status).toBe(200);
    expect(rec.writes[0].payload).toMatchObject({ sex: "female", is_gelded: false });
  });

  it("rejects {sex:'female', isGelded:true} as 400 validation_failed — OUR error, not Postgres 23514", async () => {
    const r = await PATCH(patchReq({ sex: "female", isGelded: true }), ctx());
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
    expect(j.error.message).toMatch(/isGelded/);
    expect(rec.writes).toEqual([]);
  });

  it("rejects isGelded:true when the request does not state the sex", async () => {
    const r = await PATCH(patchReq({ isGelded: true }), ctx());
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("validation_failed");
    expect(rec.writes).toEqual([]);
  });

  it("rejects a legacy race-day description in sex", async () => {
    for (const legacy of ["gelding", "colt", "filly", "mare", "stallion"]) {
      Object.assign(rec, blankRecord());
      const r = await PATCH(patchReq({ sex: legacy }), ctx());
      expect(r.status, legacy).toBe(400);
      expect((await r.json()).error.code, legacy).toBe("validation_failed");
      expect(rec.writes, legacy).toEqual([]);
    }
  });

  it("clears an unmappable legacy sex to null AND un-gelds in the same write", async () => {
    const r = await PATCH(patchReq({ sex: null }), ctx());
    expect(r.status).toBe(200);
    expect(rec.writes[0].payload).toMatchObject({ sex: null, is_gelded: false });
  });

  // The reverse direction. Without this, moving a stored gelding to female
  // leaves is_gelded=true, the CHECK rejects the row, and the operator sees a
  // raw 23514 naming the constraint.
  it("clears is_gelded when the sex moves to female and the body is silent about gelding", async () => {
    const r = await PATCH(patchReq({ sex: "female" }), ctx());
    expect(r.status).toBe(200);
    expect(rec.writes[0].payload).toMatchObject({ sex: "female", is_gelded: false });
  });

  it("leaves is_gelded alone when the sex moves TO male", async () => {
    // Becoming male does not make a horse a gelding, so nothing is inferred.
    const r = await PATCH(patchReq({ sex: "male" }), ctx());
    expect(r.status).toBe(200);
    const payload = rec.writes[0].payload as Record<string, unknown>;
    expect(payload).toMatchObject({ sex: "male" });
    expect("is_gelded" in payload).toBe(false);
  });

  it("an explicit isGelded still wins over the inferred clear", async () => {
    const r = await PATCH(patchReq({ sex: "female", isGelded: false }), ctx());
    expect(r.status).toBe(200);
    expect(rec.writes[0].payload).toMatchObject({ sex: "female", is_gelded: false });
  });

  it("returns a generic message on a database error, never the Postgres text", async () => {
    state.tables.horse = {
      mutate: { error: { code: "23514", message: 'violates check constraint "horse_gelded_implies_male"' } },
    };
    const r = await PATCH(patchReq({ story: "x" }), ctx());
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error.message).not.toMatch(/constraint|horse_gelded|relation/i);
  });

  it("leaves sex and is_gelded untouched when the body mentions neither", async () => {
    const r = await PATCH(patchReq({ story: "Just the bio." }), ctx());
    expect(r.status).toBe(200);
    const payload = rec.writes[0].payload as Record<string, unknown>;
    expect("sex" in payload).toBe(false);
    expect("is_gelded" in payload).toBe(false);
  });

  it("never writes an owner column (guardrail: no owner PII)", async () => {
    const r = await PATCH(patchReq({ sex: "male", owner: "Jane Doe", ownerEmail: "j@x.com" }), ctx());
    expect(r.status).toBe(200);
    const payload = rec.writes[0].payload as Record<string, unknown>;
    expect(Object.keys(payload).filter((k) => k.toLowerCase().includes("owner"))).toEqual([]);
  });
});
