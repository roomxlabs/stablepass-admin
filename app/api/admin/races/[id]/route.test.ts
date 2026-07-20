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
const patchReq = (body: unknown) =>
  new Request("http://t", { method: "PATCH", body: JSON.stringify(body) });

const raceUpdate = () => state.calls.mutations.find((m) => m.table === "race" && m.op === "update");

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("PATCH /api/admin/races/:id — correct a race", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await PATCH(patchReq({ venue: "Rosehill" }), ctx("r1"));
    expect(r.status).toBe(403);
  });

  it("401s with no session (guardrail)", async () => {
    state.user = null;
    const r = await PATCH(patchReq({ venue: "Rosehill" }), ctx("r1"));
    expect(r.status).toBe(401);
  });

  it("corrects a manual race WITHOUT setting manual_override", async () => {
    asAdmin();
    state.tables.race = {
      select: { single: { source: "manual" } },
      mutate: { single: { id: "r1", venue: "Rosehill", source: "manual", manual_override: false } },
    };
    const r = await PATCH(patchReq({ venue: "Rosehill" }), ctx("r1"));
    expect(r.status).toBe(200);
    expect(raceUpdate()?.payload).toEqual({ venue: "Rosehill" });
    expect(raceUpdate()?.payload).not.toHaveProperty("manual_override");
  });

  // The acceptance criterion: a correction to a feed row pins it so the RF3 poll
  // stops overwriting it.
  it("sets manual_override=true when correcting an `api` row", async () => {
    asAdmin();
    state.tables.race = {
      select: { single: { source: "api" } },
      mutate: { single: { id: "r1", venue: "Rosehill", source: "api", manual_override: true } },
    };
    const r = await PATCH(patchReq({ venue: "Rosehill" }), ctx("r1"));
    expect(r.status).toBe(200);
    expect(raceUpdate()?.payload).toMatchObject({ venue: "Rosehill", manual_override: true });
    const j = await r.json();
    expect(j.data.manual_override).toBe(true);
  });

  it("ignores a client attempt to clear manual_override on a feed row", async () => {
    asAdmin();
    state.tables.race = {
      select: { single: { source: "api" } },
      mutate: { single: { id: "r1", manual_override: true } },
    };
    await PATCH(patchReq({ venue: "Rosehill", manualOverride: false }), ctx("r1"));
    expect(raceUpdate()?.payload.manual_override).toBe(true);
  });

  it("never lets the client rewrite server-owned provenance (source)", async () => {
    asAdmin();
    state.tables.race = {
      select: { single: { source: "api" } },
      mutate: { single: { id: "r1" } },
    };
    await PATCH(patchReq({ venue: "Rosehill", source: "manual" }), ctx("r1"));
    expect(raceUpdate()?.payload).not.toHaveProperty("source");
  });

  // `patch.status != null` would let an explicit null through into a NOT NULL column.
  it("rejects an explicit null status", async () => {
    asAdmin();
    state.tables.race = { select: { single: { source: "manual" } } };
    const r = await PATCH(patchReq({ status: null }), ctx("r1"));
    expect(r.status).toBe(400);
    expect(raceUpdate()).toBeUndefined();
  });

  it("rejects an unknown status value", async () => {
    asAdmin();
    state.tables.race = { select: { single: { source: "manual" } } };
    const r = await PATCH(patchReq({ status: "abandoned" }), ctx("r1"));
    expect(r.status).toBe(400);
  });

  it("rejects a non-integer raceNumber (natural-key dedup depends on it)", async () => {
    asAdmin();
    state.tables.race = { select: { single: { source: "manual" } } };
    const r = await PATCH(patchReq({ raceNumber: "abc" }), ctx("r1"));
    expect(r.status).toBe(400);
    expect(raceUpdate()).toBeUndefined();
  });

  it("400s when no editable field is provided", async () => {
    asAdmin();
    const r = await PATCH(patchReq({ nonsense: 1 }), ctx("r1"));
    expect(r.status).toBe(400);
  });

  it("404s when the race is missing", async () => {
    asAdmin();
    state.tables.race = { select: { single: null } };
    const r = await PATCH(patchReq({ venue: "Rosehill" }), ctx("r1"));
    expect(r.status).toBe(404);
  });

  it("409s when the correction collides with another race's natural key", async () => {
    asAdmin();
    state.tables.race = {
      select: { single: { source: "manual" } },
      mutate: { error: { code: "23505", message: "duplicate key" } },
    };
    const r = await PATCH(patchReq({ raceNumber: 7 }), ctx("r1"));
    expect(r.status).toBe(409);
  });
});

describe("DELETE /api/admin/races/:id", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await DELETE(new Request("http://t"), ctx("r1"));
    expect(r.status).toBe(403);
  });

  it("204s and deletes the race", async () => {
    asAdmin();
    state.tables.race = { select: { single: { id: "r1" } }, mutate: {} };
    const r = await DELETE(new Request("http://t"), ctx("r1"));
    expect(r.status).toBe(204);
    expect(state.calls.mutations.some((m) => m.table === "race" && m.op === "delete")).toBe(true);
  });

  it("404s when the race is missing", async () => {
    asAdmin();
    state.tables.race = { select: { single: null } };
    const r = await DELETE(new Request("http://t"), ctx("r1"));
    expect(r.status).toBe(404);
  });
});
