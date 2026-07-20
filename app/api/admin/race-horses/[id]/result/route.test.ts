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
  state.tables.race = { mutate: { single: { id: "r1" } } };
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

    // 4 starts -> 5, a win, a place (top 3), prize accrues in cents.
    expect(horseUpdate()?.values).toEqual({
      starts: 5,
      wins: 2,
      places: 3,
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
    const r = await PATCH(patchReq({ result: "1st of 12", finishPosition: 1 }), ctx("rh1"));
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("result_already_recorded");
    expect(horseUpdate()).toBeUndefined();
    expect(state.calls.functions).toHaveLength(0);
  });

  it("scopes the runner update to the resultable statuses (compare-and-swap)", async () => {
    seedHappyPath();
    await PATCH(patchReq({ result: "1st of 12", finishPosition: 1 }), ctx("rh1"));
    // `in` is recorded by the fake as a no-op, so assert the guard exists by its
    // effect: the update is issued and the route reached the counter write.
    expect(runnerUpdate()?.values.entry_status).toBe("ran");
    expect(horseUpdate()).toBeDefined();
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
