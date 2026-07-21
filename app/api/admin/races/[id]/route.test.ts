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
    expect(raceUpdate()?.values).toEqual({ venue: "Rosehill" });
    expect(raceUpdate()?.values).not.toHaveProperty("manual_override");
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
    expect(raceUpdate()?.values).toMatchObject({ venue: "Rosehill", manual_override: true });
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
    expect(raceUpdate()?.values.manual_override).toBe(true);
  });

  it("never lets the client rewrite server-owned provenance (source)", async () => {
    asAdmin();
    state.tables.race = {
      select: { single: { source: "api" } },
      mutate: { single: { id: "r1" } },
    };
    await PATCH(patchReq({ venue: "Rosehill", source: "manual" }), ctx("r1"));
    expect(raceUpdate()?.values).not.toHaveProperty("source");
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

  // ENG-324. The natural key (venue, race_date, race_number) is what makes race dedup
  // work; a NULL component silently opts the row out of the UNIQUE constraint forever.
  // Each case asserts the captured mutation — a bare status assertion here is
  // attributable to the other 400 branches (see .rx/gotchas.md).
  describe("natural-key fields reject null/blank (dedup integrity)", () => {
    const cases: Array<[string, unknown]> = [
      ["raceNumber null", { raceNumber: null }],
      ["raceNumber empty string", { raceNumber: "" }],
      ["venue null", { venue: null }],
      ["venue empty string", { venue: "" }],
      ["venue whitespace only", { venue: "   " }],
      ["raceDate null", { raceDate: null }],
      ["raceDate empty string", { raceDate: "" }],
      ["raceDate whitespace only", { raceDate: "  " }],
    ];

    it.each(cases)("rejects %s with 400 and writes nothing", async (_label, body) => {
      asAdmin();
      state.tables.race = { select: { single: { source: "api" } } };
      const r = await PATCH(patchReq(body), ctx("r1"));
      expect(r.status).toBe(400);
      const j = await r.json();
      expect(j.error.code).toBe("validation_failed");
      // Assert the MESSAGE, not just the code. `Number(null)` and `Number("")` are both 0,
      // so the pre-existing `n < 1` branch also 400s on the raceNumber cases with the same
      // code — those two cases would pass with this guard deleted. The message is the only
      // thing that binds them to the natural-key guard.
      expect(j.error.message).toMatch(/is required and cannot be blank/);
      // And no UPDATE ever reached the race row.
      expect(raceUpdate()).toBeUndefined();
    });
  });

  // Padding defeats the unique index the same way a NULL does: "  Rosehill  " and
  // "Rosehill" are distinct values, so two rows can exist for one real race.
  it("normalizes a padded natural-key value before writing (dedup integrity)", async () => {
    asAdmin();
    state.tables.race = {
      select: { single: { source: "manual" } },
      mutate: { single: { id: "r1", venue: "Rosehill" } },
    };
    const r = await PATCH(patchReq({ venue: "  Rosehill  ", raceDate: " 2026-08-01 " }), ctx("r1"));
    expect(r.status).toBe(200);
    expect(raceUpdate()?.values).toMatchObject({ venue: "Rosehill", race_date: "2026-08-01" });
  });

  // Guard against over-correction: the fix must not break legitimate edits.
  it("still accepts a legitimate raceNumber correction and still pins an `api` row", async () => {
    asAdmin();
    state.tables.race = {
      select: { single: { source: "api" } },
      mutate: { single: { id: "r1", race_number: 7, source: "api", manual_override: true } },
    };
    const r = await PATCH(patchReq({ raceNumber: 7 }), ctx("r1"));
    expect(r.status).toBe(200);
    expect(raceUpdate()?.values).toMatchObject({ race_number: 7, manual_override: true });
  });

  // distance_m is NOT part of the natural key — clearing it must stay legal.
  it("still allows clearing the nullable distanceM", async () => {
    asAdmin();
    state.tables.race = {
      select: { single: { source: "manual" } },
      mutate: { single: { id: "r1", distance_m: null } },
    };
    const r = await PATCH(patchReq({ distanceM: null }), ctx("r1"));
    expect(r.status).toBe(200);
    expect(raceUpdate()?.values).toMatchObject({ distance_m: null });
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
    // Blast radius: without this predicate the delete removes EVERY race, cascading
    // every race_horse.
    //
    // COUNT, don't toContainEqual. The route reads the race before deleting it and both
    // statements emit an identical race/eq/id filter, so a bare toContainEqual is
    // satisfied by the READ alone — verified: deleting the predicate from the delete left
    // the whole suite green. `calls.filters` is flat with no statement association, so
    // the pair count is what binds this to the delete.
    const raceIdFilters = state.calls.filters.filter(
      (f) => f.table === "race" && f.op === "eq" && f.column === "id" && f.value === "r1",
    );
    expect(raceIdFilters).toHaveLength(2); // read + delete
  });

  it("404s when the race is missing", async () => {
    asAdmin();
    state.tables.race = { select: { single: null } };
    const r = await DELETE(new Request("http://t"), ctx("r1"));
    expect(r.status).toBe(404);
  });
});
