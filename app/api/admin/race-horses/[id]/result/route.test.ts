import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeFakeClient, blankState, type FakeState } from "@/lib/testing/supabase-fake";

const state: FakeState = blankState();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => makeFakeClient(state),
}));

import { PATCH, POST } from "./route";

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

// A confirmed runner ready to have its result recorded, on a horse with an existing
// career record.
function seedHappyPath() {
  asAdmin();
  state.tables.race_horse = {
    select: { single: { id: "rh1", race_id: "r1", horse_id: "h1", entry_status: "confirmed" } },
    mutate: { single: { id: "rh1", race_id: "r1", horse_id: "h1", result: "1st of 12", finish_position: 1, entry_status: "ran" } },
  };
  // Script `source` explicitly: an unscripted read yields {data: null} which the route
  // now (correctly) treats as unknown provenance and pins. RF6's own races are manual.
  state.tables.race = {
    select: { single: { id: "r1", source: "manual" } },
    mutate: { single: { id: "r1" } },
  };
  state.tables.horse = {
    select: { single: { starts: 4, wins: 1, places: 2, prize_money_cents: 500_000 } },
    mutate: { single: { id: "h1" } },
  };
}

const horseUpdate = () => state.calls.mutations.find((m) => m.table === "horse" && m.op === "update");
const raceUpdate = () => state.calls.mutations.find((m) => m.table === "race" && m.op === "update");
const runnerUpdate = () =>
  state.calls.mutations.find((m) => m.table === "race_horse" && m.op === "update");

beforeEach(() => {
  Object.assign(state, blankState());
});

describe("PATCH /api/admin/race-horses/:id/result", () => {
  it("403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await PATCH(patchReq({ result: "1st of 12" }), ctx("rh1"));
    expect(r.status).toBe(403);
  });

  it("401s with no session (guardrail)", async () => {
    state.user = null;
    const r = await PATCH(patchReq({ result: "1st of 12" }), ctx("rh1"));
    expect(r.status).toBe(401);
  });

  // The happy path the acceptance criterion names: race finished, counters moved
  // once, push invoked.
  it("records the result, finishes the race, increments counters once, invokes push", async () => {
    seedHappyPath();
    const r = await PATCH(
      patchReq({ result: "1st of 12", finishPosition: 1, prizeCents: 250_000 }),
      ctx("rh1"),
    );
    expect(r.status).toBe(200);

    expect(runnerUpdate()?.values).toMatchObject({
      result: "1st of 12",
      finish_position: 1,
      entry_status: "ran",
    });

    expect(raceUpdate()?.values.status).toBe("finished");
    expect(raceUpdate()?.values.finished_at).toBeTruthy();

    // 4 starts -> 5, a win, prize accrues in cents. `places` does NOT move: wins and places
    // are disjoint buckets (places = 2nd/3rd), so a win is not also a placing.
    expect(horseUpdate()?.values).toEqual({
      starts: 5,
      wins: 2,
      places: 2,
      prize_money_cents: 750_000,
    });

    const push = state.calls.functions.find((f) => f.name === "push-dispatch");
    expect(push?.body).toMatchObject({ type: "race_result", raceHorseId: "rh1", raceId: "r1" });
  });

  it("counts a 5th placing as a start but not a win or a place", async () => {
    seedHappyPath();
    await PATCH(patchReq({ result: "5th of 12", finishPosition: 5 }), ctx("rh1"));
    expect(horseUpdate()?.values).toEqual({
      starts: 5,
      wins: 1,
      places: 2,
      prize_money_cents: 500_000,
    });
  });

  // The counters are not re-runnable, so a second submit must be refused rather
  // than double-counted.
  it("409s when the result is already recorded — counters move exactly once", async () => {
    asAdmin();
    state.tables.race_horse = {
      select: { single: { id: "rh1", race_id: "r1", horse_id: "h1", entry_status: "ran" } },
    };
    const r = await PATCH(patchReq({ result: "1st of 12", finishPosition: 1 }), ctx("rh1"));
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("result_already_recorded");
    expect(horseUpdate()).toBeUndefined();
    expect(raceUpdate()).toBeUndefined();
    expect(state.calls.functions).toHaveLength(0);
  });

  // The status check alone is a read-then-write, so the UPDATE itself is scoped to
  // the resultable statuses. If a concurrent request already flipped the row, the
  // scoped update matches nothing and this request must not touch the counters.
  it("409s when a concurrent request won the race (scoped update matched no row)", async () => {
    asAdmin();
    state.tables.race_horse = {
      select: { single: { id: "rh1", race_id: "r1", horse_id: "h1", entry_status: "confirmed" } },
      mutate: { single: null },
    };
    // Script the race explicitly: unscripted, the source read returns null and this test
    // silently exercises the unknown-provenance pin branch it was never written for.
    state.tables.race = {
      select: { single: { id: "r1", source: "manual" } },
      mutate: { single: { id: "r1" } },
    };
    const r = await PATCH(patchReq({ result: "1st of 12", finishPosition: 1 }), ctx("rh1"));
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("result_already_recorded");
    expect(horseUpdate()).toBeUndefined();
    expect(state.calls.functions).toHaveLength(0);
  });

  it("scopes the runner update to the resultable statuses (compare-and-swap)", async () => {
    seedHappyPath();
    await PATCH(patchReq({ result: "1st of 12", finishPosition: 1 }), ctx("rh1"));
    expect(runnerUpdate()?.values.entry_status).toBe("ran");
    // The predicate IS the idempotency guard, so assert it directly. Asserting only the
    // effect passed with the guard deleted — `calls.filters` is what closes that hole.
    expect(state.calls.filters).toContainEqual({
      table: "race_horse",
      op: "in",
      column: "entry_status",
      value: ["confirmed", "nominated"],
    });
  });

  it("scopes the race finish to an upcoming race, so a later runner can't rewrite finished_at", async () => {
    seedHappyPath();
    await PATCH(patchReq({ result: "1st of 12", finishPosition: 1 }), ctx("rh1"));
    expect(state.calls.filters).toContainEqual({
      table: "race",
      op: "eq",
      column: "status",
      value: "upcoming",
    });
  });

  it("targets exactly one horse row when incrementing career counters", async () => {
    seedHappyPath();
    await PATCH(patchReq({ result: "1st of 12", finishPosition: 1 }), ctx("rh1"));
    // Without the predicate on the UPDATE, the counter write hits every horse row
    // visible to the admin's RLS.
    //
    // `calls.filters` is a FLAT list with no statement association, so a plain
    // toContainEqual here is satisfied by the horse READ's own `.eq("id", …)` two
    // statements earlier and proves nothing — verified: deleting the update's predicate
    // left that version green. Counting both occurrences is what actually binds this to
    // the update. Brittle if a third horse query is added; the count is the point.
    const horseIdFilters = state.calls.filters.filter(
      (f) => f.table === "horse" && f.op === "eq" && f.column === "id" && f.value === "h1",
    );
    expect(horseIdFilters).toHaveLength(2); // read + update
  });

  // GUARDRAIL: recording a result by hand on a FEED race must pin it, or the next RF3
  // poll re-opens the race, re-ingests the official result, and the career counters
  // increment a second time. Counters are never decremented.
  const raceUpdates = () =>
    state.calls.mutations.filter((m) => m.table === "race" && m.op === "update");

  it("pins an api race with manual_override, as its OWN id-scoped write", async () => {
    seedHappyPath();
    state.tables.race = {
      select: { single: { id: "r1", source: "api" } },
      mutate: { single: { id: "r1" } },
    };
    await PATCH(patchReq({ result: "1st of 12", finishPosition: 1 }), ctx("rh1"));
    // Two separate race updates: the pin, then the status transition. They must NOT be
    // merged — the transition is scoped .eq("status","upcoming"), so folding the pin into
    // it drops the pin silently on a race that is already finished.
    expect(raceUpdates()).toHaveLength(2);
    expect(raceUpdates()[0].values).toEqual({ manual_override: true });
    expect(raceUpdates()[1].values).toMatchObject({ status: "finished" });
    expect(raceUpdates()[1].values).not.toHaveProperty("manual_override");
  });

  // NOTE: an "already-finished api race" test was removed here rather than kept as
  // reassurance. It was inert — mutating its fixture's `status` to a bogus value left the
  // whole suite green, because the route reads only `source` and the fake does not model
  // `.eq("status","upcoming")` matching zero rows. Its assertions were a strict subset of
  // the test above. Modelling that case needs filter-aware zero-row matching in
  // supabase-fake (see ENG-321); a test that cannot fail is worse than none, because it
  // reads as coverage.

  // GUARDRAIL: `race` has TWO permissive policies — race_select_sub (has_content_access)
  // and race_all_admin (is_admin) — so SELECT visibility is strictly BROADER than UPDATE
  // visibility. The dangerous case is a race that reads back cleanly and whose pin is
  // then silently filtered, returning zero rows with no error. Without proving the pin
  // landed, the handler proceeds to the counters and the push, and the next poll
  // double-counts.
  //
  // This is the VISIBLE-race instance and it is the one that matters: scripting the read
  // as null instead conflates "race invisible" with "pin filtered", and a refusal
  // narrowed to `!pinnedRow && !raceRow` would still pass that weaker test while
  // reopening the hole for every visible api race.
  it("409s when a VISIBLE api race's pin is silently filtered", async () => {
    seedHappyPath();
    state.tables.race = {
      select: { single: { id: "r1", source: "api" } }, // fully visible, provenance known
      mutate: { single: null }, // ...but the UPDATE matches 0 rows, no error
    };
    const r = await PATCH(patchReq({ result: "1st of 12", finishPosition: 1 }), ctx("rh1"));
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("pin_failed");
    expect(state.calls.mutations.some((m) => m.table === "race_horse")).toBe(false);
    expect(state.calls.mutations.some((m) => m.table === "horse")).toBe(false);
    expect(state.calls.functions).toHaveLength(0);
  });

  it("409s and mutates nothing when an INVISIBLE race's pin matches zero rows", async () => {
    seedHappyPath();
    state.tables.race = {
      select: { single: null }, // row not visible → unknown provenance → pin
      mutate: { single: null }, // ...and the pin itself matches nothing, no error
    };
    const r = await PATCH(patchReq({ result: "1st of 12", finishPosition: 1 }), ctx("rh1"));
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("pin_failed");
    expect(state.calls.mutations.some((m) => m.table === "race_horse")).toBe(false);
    expect(state.calls.functions).toHaveLength(0);
  });

  it("does NOT set manual_override on a manual race (the poll never touches it)", async () => {
    seedHappyPath();
    state.tables.race = {
      select: { single: { id: "r1", source: "manual" } },
      mutate: { single: { id: "r1" } },
    };
    await PATCH(patchReq({ result: "1st of 12", finishPosition: 1 }), ctx("rh1"));
    expect(raceUpdates()).toHaveLength(1); // status transition only
    expect(raceUpdates()[0].values).not.toHaveProperty("manual_override");
  });

  // Fail safe on UNKNOWN provenance. Both branches matter and they fail differently:
  // a read error is loud, a null row is silent — and the silent one is what an RLS
  // regression produces, since SELECT policies filter rather than error.
  it("pins when the source read ERRORS (fail-safe)", async () => {
    seedHappyPath();
    state.tables.race = {
      // BOTH single and error. The fake returns `data: pick().single ?? null`, so an
      // error-only fixture also yields data:null and `!raceRow` alone satisfies the
      // branch — leaving `raceReadErr` with zero exclusive coverage. Scripting a visible
      // row means only the error clause can be what fires here.
      select: { single: { id: "r1", source: "manual" }, error: { message: "read boom" } },
      mutate: { single: { id: "r1" } },
    };
    await PATCH(patchReq({ result: "1st of 12", finishPosition: 1 }), ctx("rh1"));
    expect(raceUpdates()[0].values).toEqual({ manual_override: true });
  });

  it("pins when the race row is NOT VISIBLE — an RLS filter returns null, not an error", async () => {
    seedHappyPath();
    state.tables.race = {
      select: { single: null },
      mutate: { single: { id: "r1" } },
    };
    await PATCH(patchReq({ result: "1st of 12", finishPosition: 1 }), ctx("rh1"));
    expect(raceUpdates()[0].values).toEqual({ manual_override: true });
  });

  // The pin runs BEFORE the CAS precisely so a pin failure mutates nothing. Assert both
  // halves: the 400, and that no runner/horse write happened.
  it("400s and mutates nothing when the pin itself fails", async () => {
    seedHappyPath();
    state.tables.race = {
      select: { single: { id: "r1", source: "api" } },
      mutate: { error: { message: "pin boom" } },
    };
    const r = await PATCH(patchReq({ result: "1st of 12", finishPosition: 1 }), ctx("rh1"));
    expect(r.status).toBe(400);
    expect(state.calls.mutations.some((m) => m.table === "race_horse")).toBe(false);
    expect(state.calls.mutations.some((m) => m.table === "horse")).toBe(false);
    expect(state.calls.functions).toHaveLength(0);
  });

  // The pin is a bare UPDATE with no natural guard, so an unscoped one would set
  // manual_override on EVERY race and freeze the entire feed. Count-bound (see
  // .rx/gotchas.md): read + pin + finish all emit race/eq/id.
  it("scopes the pin to this race only", async () => {
    seedHappyPath();
    state.tables.race = {
      select: { single: { id: "r1", source: "api" } },
      mutate: { single: { id: "r1" } },
    };
    await PATCH(patchReq({ result: "1st of 12", finishPosition: 1 }), ctx("rh1"));
    const raceIdFilters = state.calls.filters.filter(
      (f) => f.table === "race" && f.op === "eq" && f.column === "id" && f.value === "r1",
    );
    expect(raceIdFilters).toHaveLength(3); // read + pin + finish
  });

  // A horse that never left the barrier must not earn a career start. The guard is
  // an allowlist, not "anything but 'ran'".
  it.each(["scratched", "not_accepted"])(
    "409s for a %s runner and leaves the counters alone",
    async (entryStatus) => {
      asAdmin();
      state.tables.race_horse = {
        select: { single: { id: "rh1", race_id: "r1", horse_id: "h1", entry_status: entryStatus } },
      };
      const r = await PATCH(patchReq({ result: "5th of 12", finishPosition: 5 }), ctx("rh1"));
      expect(r.status).toBe(409);
      expect((await r.json()).error.code).toBe("runner_did_not_run");
      expect(horseUpdate()).toBeUndefined();
      expect(state.calls.functions).toHaveLength(0);
    },
  );

  it("allows a nominated runner to be resulted", async () => {
    seedHappyPath();
    state.tables.race_horse.select = {
      single: { id: "rh1", race_id: "r1", horse_id: "h1", entry_status: "nominated" },
    };
    const r = await PATCH(patchReq({ result: "3rd of 9", finishPosition: 3 }), ctx("rh1"));
    expect(r.status).toBe(200);
    expect(horseUpdate()?.values.places).toBe(3);
  });

  // places = 2nd/3rd only, per RF3. Wins and places are disjoint buckets, so 1st must NOT
  // increment places — the whole boundary is pinned here so the rule cannot drift back to a
  // top-3 reading without going red. Baseline is 4 starts / 1 win / 2 places.
  it.each([
    [1, { wins: 2, places: 2 }],
    [2, { wins: 1, places: 3 }],
    [3, { wins: 1, places: 3 }],
    [4, { wins: 1, places: 2 }],
  ])("counts a finish of %i into the right career bucket", async (finishPosition, expected) => {
    seedHappyPath();
    const r = await PATCH(patchReq({ result: `${finishPosition} of 12`, finishPosition }), ctx("rh1"));
    expect(r.status).toBe(200);
    expect(horseUpdate()?.values).toMatchObject({ starts: 5, ...expected });
  });

  // The UI posts finishPosition as a STRING (`RaceDetail.tsx` fills the draft from e.target.value),
  // so the `Number()` at route.ts:46 is load-bearing: the bucket rule uses strict equality, and
  // `"2" === 2` is false. Drop the coercion and every wins/places increment silently stops while
  // the numeric tests above stay green. This pins the real wire shape.
  it.each([
    ["1", { wins: 2, places: 2 }],
    ["2", { wins: 1, places: 3 }],
    ["3", { wins: 1, places: 3 }],
    ["4", { wins: 1, places: 2 }],
  ])("buckets a string finishPosition of %s as the UI sends it", async (finishPosition, expected) => {
    seedHappyPath();
    const r = await PATCH(patchReq({ result: `${finishPosition} of 12`, finishPosition }), ctx("rh1"));
    expect(r.status).toBe(200);
    expect(horseUpdate()?.values).toMatchObject({ starts: 5, ...expected });
  });

  // A later runner on the same race must not rewrite finished_at.
  it("scopes the race transition to an upcoming race", async () => {
    seedHappyPath();
    await PATCH(patchReq({ result: "1st of 12", finishPosition: 1 }), ctx("rh1"));
    expect(raceUpdate()?.values).toMatchObject({ status: "finished" });
  });

  // The runner is already flipped to 'ran' by this point, so a silently-skipped
  // counter write could never be retried — it must fail loudly, not 200.
  it("fails loudly when the horse row is missing rather than silently skipping counters", async () => {
    seedHappyPath();
    state.tables.horse = { select: { single: null } };
    const r = await PATCH(patchReq({ result: "1st of 12", finishPosition: 1 }), ctx("rh1"));
    expect(r.status).toBe(404);
  });

  // The scaffold shipped this endpoint as POST; the alias must carry the same gate.
  it("POST alias 403s for a non-admin (guardrail)", async () => {
    asNonAdmin();
    const r = await POST(patchReq({ result: "1st of 12" }), ctx("rh1"));
    expect(r.status).toBe(403);
  });

  it("POST alias behaves identically to PATCH", async () => {
    seedHappyPath();
    const r = await POST(patchReq({ result: "1st of 12", finishPosition: 1 }), ctx("rh1"));
    expect(r.status).toBe(200);
    expect(horseUpdate()?.values.starts).toBe(5);
  });

  it("404s when the runner is missing", async () => {
    asAdmin();
    state.tables.race_horse = { select: { single: null } };
    const r = await PATCH(patchReq({ result: "1st" }), ctx("rh1"));
    expect(r.status).toBe(404);
  });

  it("400s when neither result nor finishPosition is given", async () => {
    asAdmin();
    const r = await PATCH(patchReq({}), ctx("rh1"));
    expect(r.status).toBe(400);
  });

  it("400s on a nonsense finishPosition or a negative prize", async () => {
    asAdmin();
    expect((await PATCH(patchReq({ finishPosition: 0 }), ctx("rh1"))).status).toBe(400);
    expect((await PATCH(patchReq({ result: "1st", prizeCents: -5 }), ctx("rh1"))).status).toBe(400);
  });

  // Guardrail: the fan-out is best-effort — a notify failure must not roll back a
  // recorded result.
  it("still succeeds when push-dispatch fails", async () => {
    seedHappyPath();
    state.functions["push-dispatch"] = { error: { message: "edge down" } };
    const r = await PATCH(patchReq({ result: "1st of 12", finishPosition: 1 }), ctx("rh1"));
    expect(r.status).toBe(200);
    expect((await r.json()).data.notificationsSent).toBe(0);
  });

  it("never writes an odds or betting field (guardrail §6)", async () => {
    seedHappyPath();
    await PATCH(patchReq({ result: "1st", finishPosition: 1, odds: "2.10", wager: 50 }), ctx("rh1"));
    const keys = Object.keys(runnerUpdate()?.values ?? {});
    expect(keys).not.toContain("odds");
    expect(keys).not.toContain("wager");
  });
});
